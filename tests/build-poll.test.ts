/**
 * 构建状态轮询与构建队列页的集成测试（A14）：连真数据库，网络层换成假的 CRP / Shuttle。
 *
 * 走的是生产代码的完整链路 —— `runBuildPoll` → `pollReleaseBuilds` + `getTopicWorkflow`
 * （含 CRP 请求层、重试、调用记录）→ `build_poll_event`；只有最后一步 HTTP 被替换掉，
 * 因为真实 CRP / Shuttle 不能出现在测试里。
 *
 * 锁住本节点的验收标准与 MUST：
 *
 * - AC1：提测出现进队列，且能看出「谁在等谁」；
 * - AC2：上游构建成功后，下游从「等待依赖」变成「投递中」；
 * - AC3：已完结的提测不再被轮询（一条请求都不发）；
 * - AC4：制造一次 Shuttle 超时，提测状态不变、留下同步错误记录；
 * - AC5：Topic 推进到已转测后，一个轮询周期内 `crpWorkProgress` >= 20；
 * - MUST：取不到工作流进度时保留旧值，绝不写 0；调度事件流水五列齐全。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { POST as pollJobPost } from "../app/api/jobs/build-poll/route";
import {
  ACTIVE_RELEASE_STATES,
  formatDuration,
  listPollEvents,
  loadBuildQueue,
  loadReleaseBuildStatus,
  pickWorkflowProgress,
  queueStageOf,
  runBuildPoll,
} from "../lib/build";
import { prisma } from "../lib/db";

const PREFIX = "zza14";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
/** 基线在 CRP 侧的分支 ID，必须是数字。 */
const CRP_BRANCH_ID = "9981208";

const CRP_BASE = "https://crp.example.test/api";
const SHUTTLE_BASE = "https://shuttle.example.test/api/shuttle";

/** 三个包的提交号，各自不同，方便认出快照来自哪一轮。 */
const SHA_A = "a14a0000000000000000000000000000000000001";
const SHA_B = "a14b0000000000000000000000000000000000002";
const SHA_C = "a14c0000000000000000000000000000000000003";

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

// ---------------------------------------------------------------------------
// 假的 CRP / Shuttle
// ---------------------------------------------------------------------------

type FakeRelease = {
  ID: number;
  TopicID: number;
  ProjectID: number;
  ProjectName: string;
  Branch: string;
  Commit: string;
  Tag: string;
  BuildID: number;
  Status?: number;
  StatusName?: string;
};

type FakeBuild = {
  packageName: string;
  task: string;
  jobs: Array<{ id: number; arch: string; status: string }>;
};

type FakeState = {
  /** 本测试要轮询的那条 Topic。 */
  topicId: number;
  releases: FakeRelease[];
  builds: Map<number, FakeBuild>;
  /** `workflow/info` 的响应体。给全零对象就是「取不到工作流信息」的场景。 */
  workflow: { TopicID?: number; WorkProgress?: number };
  /** 收到的每一个 CRP 请求，按发生顺序。 */
  received: string[];
  /** 为真时 Shuttle 一律「请求超时」。 */
  shuttleDown: boolean;
  nextReleaseId: number;
  nextBuildId: number;
  nextJobId: number;
};

/** 每个测试用一段独立的 ID 区间：Topic、Release、构建任务的 ID 在库里都是唯一的。 */
let fakeIdBase = 71_000;

function newFakeState(topicId: number): FakeState {
  const base = fakeIdBase;
  fakeIdBase += 1_000;

  return {
    topicId,
    releases: [],
    builds: new Map(),
    workflow: { TopicID: topicId, WorkProgress: 10 },
    received: [],
    shuttleDown: false,
    nextReleaseId: base,
    nextBuildId: base + 500,
    nextJobId: base + 700,
  };
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  return new URL(url).pathname.replace(/^\/api/, "");
}

/** 假的 CRP 网络层：行为按 `lib/integrations/crp/FINDINGS.md` 里实测的响应形态写。 */
function crpFetchOf(state: FakeState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    state.received.push(`${method} ${path}`);

    // 只回答本夹具的 Topic：轮询是全库挑活的，库里别的夹具留下的提测不该被这里的假数据改写。
    if (!path.startsWith(`/topics/${state.topicId}/`)) {
      return json(JSON.stringify({ message: `测试只实现 Topic ${state.topicId}：${method} ${path}` }), 404);
    }

    const listReleases = /^\/topics\/(\d+)\/releases$/.exec(path);

    if (method === "GET" && listReleases !== null) {
      const topicId = Number(listReleases[1]);

      return json(JSON.stringify(state.releases.filter((item) => item.TopicID === topicId)));
    }

    const workflow = /^\/topics\/(\d+)\/workflow\/info$/.exec(path);

    if (method === "GET" && workflow !== null) {
      // 实测：还没走过工作流的 Topic 返回全零对象，而不是 404。
      return json(JSON.stringify(state.workflow));
    }

    const newRelease = /^\/topics\/(\d+)\/new_release$/.exec(path);

    if (method === "POST" && newRelease !== null) {
      const body = JSON.parse(String(init?.body)) as {
        TopicID: number;
        ProjectName: string;
        Branch: string;
        Commit: string;
        Tag: string;
      };

      const buildId = state.nextBuildId++;
      const jobId = state.nextJobId++;
      const release: FakeRelease = {
        ID: state.nextReleaseId++,
        TopicID: body.TopicID,
        ProjectID: 800,
        ProjectName: body.ProjectName,
        Branch: body.Branch,
        Commit: body.Commit,
        Tag: body.Tag,
        BuildID: buildId,
        Status: 1,
        StatusName: "APPLYING",
      };

      state.releases.push(release);
      state.builds.set(buildId, {
        packageName: body.ProjectName,
        task: "BUILDING",
        jobs: [{ id: jobId, arch: "amd64", status: "BUILDING" }],
      });

      return json(String(release.ID), 201);
    }

    return json(JSON.stringify({ message: `测试没有实现 ${method} ${path}` }), 404);
  }) as typeof fetch;
}

/** 假的 Shuttle：`shuttleDown` 时按「请求超时」抛错。 */
function shuttleFetchOf(state: FakeState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.shuttleDown) {
      throw new Error("测试制造的 Shuttle 请求超时");
    }

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname.replace(/^\/api\/shuttle/, "");

    if (path !== "/task/list") {
      return json(JSON.stringify({ message: `测试没有实现 ${path}` }), 404);
    }

    const body = JSON.parse(String(init?.body)) as { params: { taskid: string } | null };
    const build = body.params === null ? undefined : state.builds.get(Number(body.params.taskid));

    if (build === undefined) {
      // 实测：查不到时 tasks 为 null、total 为 0，不报错。
      return json(JSON.stringify({ tasks: null, total: 0 }));
    }

    return json(
      JSON.stringify({
        tasks: [
          {
            key: Number(body.params?.taskid),
            pkgname: build.packageName,
            pkgver: "1.0.0",
            reponame: "eagle-1071",
            action: "release-candidate",
            status: build.task,
            status_changed: "",
            username: "crp-user",
            pkgtype: "deb",
            jobs: build.jobs,
          },
        ],
        total: 1,
      }),
    );
  }) as typeof fetch;
}

/** 一轮「真请求层 + 假网络」的轮询。 */
function networkOf(state: FakeState) {
  return {
    crpBaseUrl: CRP_BASE,
    crpToken: "test-token",
    crpFetch: crpFetchOf(state),
    shuttleBaseUrl: SHUTTLE_BASE,
    shuttleFetch: shuttleFetchOf(state),
  };
}

// ---------------------------------------------------------------------------
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
  managerId: string;
  projectId: string;
};

let fixture: Fixture;

async function cleanup(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { workspace: { slug: WORKSPACE_SLUG } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);
  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  // 事件流水随提测级联删除，这里只清理其余按外键排列的表。
  await prisma.crpCallLog.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.buildJob.deleteMany({ where: { buildTask: { releaseId: { in: releaseIds } } } });
  await prisma.buildTask.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releasePackageSnapshot.updateMany({
    where: { releaseId: { in: releaseIds } },
    data: { supersededById: null },
  });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });

  const baselines = await prisma.baseline.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });

  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselines.map((item) => item.id) } } });
  await prisma.packageDependency.deleteMany({
    where: { package: { name: { startsWith: PREFIX } } },
  });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.membership.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} 开发者`,
    },
    select: { id: true },
  });

  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: { crpBranchId: CRP_BRANCH_ID, name: `${PREFIX}-baseline`, syncedAt: new Date() },
    select: { id: true },
  });
  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-project`,
      name: `${PREFIX} 项目`,
    },
    select: { id: true },
  });

  // 三层依赖链：b 依赖 a，c 依赖 b。
  const packageA = await prisma.package.create({
    data: { name: pkgName("a"), repoPath: `${PREFIX}/a`, defaultBranch: "develop/eagle" },
    select: { id: true },
  });
  const packageB = await prisma.package.create({
    data: { name: pkgName("b"), repoPath: `${PREFIX}/b`, defaultBranch: "develop/eagle" },
    select: { id: true },
  });
  const packageC = await prisma.package.create({
    data: { name: pkgName("c"), repoPath: `${PREFIX}/c`, defaultBranch: "develop/eagle" },
    select: { id: true },
  });

  await prisma.packageDependency.create({
    data: { packageId: packageB.id, upstreamPackageId: packageA.id },
  });
  await prisma.packageDependency.create({
    data: { packageId: packageC.id, upstreamPackageId: packageB.id },
  });

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    managerId: manager.id,
    projectId: project.id,
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 造一条已在库里的提测（跳过 A12 的投递过程，直接摆出投递之后的样子）
// ---------------------------------------------------------------------------

type SeedSnapshot = {
  suffix: string;
  status: "pending" | "dispatching" | "building" | "success" | "failed";
  /** 填了就说明这个包已投递到 CRP。 */
  crpReleaseId?: number;
  crpBuildId?: number;
  buildTask?: {
    status: "pending" | "building" | "success" | "failed";
    shuttleTaskId?: string;
    startedAt?: Date;
    finishedAt?: Date;
  };
  jobs?: Array<{ arch: string; status: "pending" | "building" | "success" | "failed" }>;
};

type SeedInput = {
  version: string;
  status: "pending" | "dispatching" | "building" | "success" | "partial_failure" | "failed";
  /** 传 `null` 表示还没建 CRP Topic。 */
  topicId: number | null;
  workProgress?: number | null;
  snapshots: SeedSnapshot[];
};

async function seedRelease(input: SeedInput): Promise<{ releaseId: string; snapshotIds: string[] }> {
  const created = await prisma.release.create({
    data: {
      projectId: fixture.projectId,
      version: input.version,
      status: input.status,
      crpTopicId: input.topicId === null ? null : String(input.topicId),
      crpBranchId: CRP_BRANCH_ID,
      createdById: fixture.userId,
      crpWorkProgress: input.workProgress ?? null,
    },
    select: { id: true },
  });

  const snapshotIds: string[] = [];

  for (const snapshot of input.snapshots) {
    const row = await prisma.releasePackageSnapshot.create({
      data: {
        releaseId: created.id,
        packageName: pkgName(snapshot.suffix),
        attempt: 1,
        branch: "develop/eagle",
        commitSha: snapshot.suffix === "a" ? SHA_A : snapshot.suffix === "b" ? SHA_B : SHA_C,
        codeVersion: "1.0.1",
        releaseVersion: `1.0.${snapshot.suffix.charCodeAt(0)}`,
        status: snapshot.status,
      },
      select: { id: true },
    });

    snapshotIds.push(row.id);

    if (snapshot.crpReleaseId !== undefined && snapshot.crpBuildId !== undefined) {
      await prisma.releaseRepositoryRecord.create({
        data: {
          releaseId: created.id,
          snapshotId: row.id,
          crpReleaseId: String(snapshot.crpReleaseId),
          crpBuildId: String(snapshot.crpBuildId),
          lastSyncedAt: new Date(),
        },
      });
    }

    if (snapshot.buildTask !== undefined) {
      await prisma.buildTask.create({
        data: {
          releaseId: created.id,
          snapshotId: row.id,
          status: snapshot.buildTask.status,
          shuttleTaskId: snapshot.buildTask.shuttleTaskId ?? null,
          startedAt: snapshot.buildTask.startedAt ?? null,
          finishedAt: snapshot.buildTask.finishedAt ?? null,
          jobs:
            snapshot.jobs === undefined
              ? undefined
              : {
                  create: snapshot.jobs.map((job, index) => ({
                    shuttleJobId: `${created.id}-${snapshot.suffix}-${index}`,
                    arch: job.arch,
                    status: job.status,
                    startedAt: snapshot.buildTask?.startedAt ?? null,
                    finishedAt: job.status === "building" || job.status === "pending" ? null : new Date(),
                  })),
                },
        },
      });
    }
  }

  return { releaseId: created.id, snapshotIds };
}

/** 一条提测的 CRP Release 列表 + 构建任务，按「a 已在构建」摆好。 */
function stageBuildInChain(
  state: FakeState,
  releaseId: number,
  buildId: number,
  suffix: string,
): void {
  state.releases.push({
    ID: releaseId,
    TopicID: state.topicId,
    ProjectID: 800,
    ProjectName: pkgName(suffix),
    Branch: "develop/eagle",
    Commit: SHA_A,
    Tag: "1.0.1",
    BuildID: buildId,
    Status: 1,
    StatusName: "APPLYING",
  });
  state.builds.set(buildId, {
    packageName: pkgName(suffix),
    task: "BUILDING",
    jobs: [{ id: buildId + 1, arch: "amd64", status: "BUILDING" }],
  });
}

async function releaseRow(releaseId: string) {
  return prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { status: true, crpWorkProgress: true, crpWorkProgressLabel: true, crpWorkProgressSyncedAt: true },
  });
}

async function snapshotStatuses(releaseId: string): Promise<Map<string, string>> {
  const rows = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId, supersededById: null },
    select: { packageName: true, status: true },
  });

  return new Map(rows.map((row) => [row.packageName, row.status]));
}

/** 队列页里某个包的阶段名。 */
async function stagesOf(releaseId: string): Promise<Map<string, string>> {
  const view = await loadBuildQueue(fixture.workspaceId);
  const release = view.releases.find((item) => item.releaseId === releaseId);

  assert.ok(release !== undefined, `队列里应出现提测 ${releaseId}`);

  return new Map(release.tasks.map((task) => [task.packageName, task.stage]));
}

/**
 * 把本夹具之前测试留下的提测全部标成已完结。
 *
 * 轮询是全库挑活的（工具就该这样），所以每个验证轮询范围的测试都要先清场，
 * 否则上一个测试留下的「构建中」提测会混进本轮名单。
 */
async function closeLeftoverReleases(): Promise<void> {
  await prisma.release.updateMany({
    where: {
      projectId: fixture.projectId,
      status: { in: [...ACTIVE_RELEASE_STATES] },
    },
    data: { status: "success" },
  });
}

/** 全库当前该被轮询的提测条数。外来夹具留下的提测也算，断言才对得上。 */
function activeReleaseCount(): Promise<number> {
  return prisma.release.count({ where: { status: { in: [...ACTIVE_RELEASE_STATES] } } });
}

// ---------------------------------------------------------------------------
// 纯函数：工作流进度的取值规则 / 阶段名 / 耗时格式
// ---------------------------------------------------------------------------

test("纯函数：全零工作流对象算取不到，正常的 0 与 20 都照用", () => {
  // 还没走过工作流时的实测响应：全零对象。
  assert.equal(pickWorkflowProgress({ TopicID: 0, WorkProgress: 0 }), null);
  // 字段缺失也是取不到。
  assert.equal(pickWorkflowProgress({}), null);
  assert.equal(pickWorkflowProgress({ TopicID: 9123 }), null);
  assert.equal(pickWorkflowProgress(null), null);
  // 显式 null 与空串都不能当 0（`Number(null)` 正好是 0，会把已转测的提测写回「未开始」）。
  assert.equal(pickWorkflowProgress({ TopicID: 9123, WorkProgress: null }), null);
  assert.equal(pickWorkflowProgress({ TopicID: 9123, WorkProgress: "" }), null);

  // Topic 号正常、进度真的是 0：这是「未开始」，不是取不到。
  assert.deepEqual(pickWorkflowProgress({ TopicID: 9123, WorkProgress: 0 }), {
    workProgress: 0,
    workProgressLabel: "未开始",
  });
  // 已转测。
  assert.deepEqual(pickWorkflowProgress({ TopicID: 9123, WorkProgress: 20 }), {
    workProgress: 20,
    workProgressLabel: "转测试中（无法更新包）",
  });
  // 数字写成字符串也认（CRP 的字段类型是数字，这里只是不让它变成「取不到」）。
  assert.equal(pickWorkflowProgress({ TopicID: 9123, WorkProgress: "20" })?.workProgress, 20);
});

test("纯函数：阶段名区分「等待依赖」「待投递」「已阻断」", () => {
  assert.equal(queueStageOf({ snapshotStatus: "pending", upstreamReady: false, blockedBy: null }).phase, "waiting");
  assert.equal(queueStageOf({ snapshotStatus: "pending", upstreamReady: true, blockedBy: null }).name, "待投递");
  assert.equal(queueStageOf({ snapshotStatus: "building", upstreamReady: true, blockedBy: null }).phase, "running");
  // 被阻断的包在库里是 failed，但页面上必须与「构建失败」分开。
  assert.equal(
    queueStageOf({ snapshotStatus: "failed", upstreamReady: true, blockedBy: pkgName("a") }).name,
    `已阻断（上游 ${pkgName("a")} 失败）`,
  );
  assert.equal(queueStageOf({ snapshotStatus: "failed", upstreamReady: true, blockedBy: null }).name, "失败");

  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(30_000), "不到 1 分钟");
  assert.equal(formatDuration(90 * 60_000), "1 小时 30 分钟");
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC5：队列里的等待关系、上游成功后下游开始投递、工作流进度回写
// ---------------------------------------------------------------------------

test("AC1/AC2/AC5 队列显示等待关系，上游成功后下游开始投递，工作流进度随轮询回写", async () => {
  await closeLeftoverReleases();

  const topicId = 90_001;
  const state = newFakeState(topicId);
  const network = networkOf(state);

  const seeded = await seedRelease({
    version: "a14-ac12",
    status: "building",
    topicId,
    snapshots: [
      {
        suffix: "a",
        status: "building",
        crpReleaseId: 5_001,
        crpBuildId: 2_001,
        buildTask: { status: "building", shuttleTaskId: "2001", startedAt: new Date() },
        jobs: [{ arch: "amd64", status: "building" }],
      },
      { suffix: "b", status: "pending" },
      { suffix: "c", status: "pending" },
    ],
  });

  stageBuildInChain(state, 5_001, 2_001, "a");

  // AC1：投递之后就出现在队列里，而且看得出 b、c 在等谁。
  const before = await loadBuildQueue(fixture.workspaceId);
  const release = before.releases.find((item) => item.releaseId === seeded.releaseId);
  assert.ok(release !== undefined);

  assert.deepEqual(
    release.tasks.map((task) => [task.packageName, task.stage]),
    [
      [pkgName("a"), "构建中"],
      [pkgName("b"), "等待依赖"],
      [pkgName("c"), "等待依赖"],
    ],
  );
  assert.deepEqual(
    release.tasks.find((task) => task.packageName === pkgName("b"))?.waitingFor,
    [pkgName("a")],
  );
  assert.deepEqual(
    release.tasks.find((task) => task.packageName === pkgName("c"))?.waitingFor,
    [pkgName("b")],
  );

  // 统计卡：3 个包还没到终态，1 个在构建，2 个在等依赖。
  assert.equal(before.stats.queued, 3);
  assert.equal(before.stats.building, 1);
  assert.equal(before.stats.waiting, 2);

  // 一轮轮询：a 还在构建，工作流进度 10（更新）。
  const expectedCount = await activeReleaseCount();
  const first = await runBuildPoll({ trigger: "schedule", network });
  const firstItem = first.items.find((item) => item.releaseId === seeded.releaseId);

  assert.equal(first.releaseCount, expectedCount, "本轮名单应等于全库未完结的提测数");
  assert.ok(firstItem !== undefined);
  assert.equal(firstItem.error, null);
  assert.equal(firstItem.workProgress, 10);

  const afterFirstPoll = await releaseRow(seeded.releaseId);
  assert.equal(afterFirstPoll.crpWorkProgress, 10);
  assert.equal(afterFirstPoll.crpWorkProgressLabel, "更新");
  assert.notEqual(afterFirstPoll.crpWorkProgressSyncedAt, null);

  // a 构建成功、Topic 推进到「转测试中」。
  const build = state.builds.get(2_001);
  assert.ok(build !== undefined);
  build.task = "BUILD_OK";
  build.jobs = build.jobs.map((job) => ({ ...job, status: "BUILD_OK" }));
  state.workflow = { TopicID: topicId, WorkProgress: 20 };

  const second = await runBuildPoll({ trigger: "schedule", network });
  const secondItem = second.items.find((item) => item.releaseId === seeded.releaseId);

  assert.equal(secondItem?.succeeded.includes(pkgName("a")), true);

  // AC5：一个轮询周期内 crpWorkProgress 变成 20。
  const afterTransferred = await releaseRow(seeded.releaseId);
  assert.equal(afterTransferred.crpWorkProgress, 20);
  assert.ok(
    (afterTransferred.crpWorkProgress ?? 0) >= 20,
    "已转测后一个轮询周期内就应回写到 >= 20",
  );
  assert.equal(afterTransferred.crpWorkProgressLabel, "转测试中（无法更新包）");
  assert.equal((await snapshotStatuses(seeded.releaseId)).get(pkgName("a")), "success");

  // MUST：状态变化进流水，值是真的变了才记。
  const events = await listPollEvents(fixture.workspaceId, 100);
  const statusEvents = events.filter(
    (item) => item.event === "status" && item.releaseId === seeded.releaseId,
  );
  assert.equal(statusEvents.length, 1, "只应记一条 a 的状态变化，重复轮询不再记");
  assert.equal(statusEvents[0]?.packageName, pkgName("a"));
  assert.equal(statusEvents[0]?.result.startsWith("构建中 → 成功"), true);
  assert.notEqual(statusEvents[0]?.condition, "");
  assert.notEqual(statusEvents[0]?.createdAt, undefined);

  // MUST：每一轮都有 poll / progress 两条流水，五列齐全。
  const pollEvents = events.filter(
    (item) => item.event === "poll" && item.releaseId === seeded.releaseId,
  );
  const progressEvents = events.filter(
    (item) => item.event === "progress" && item.releaseId === seeded.releaseId,
  );
  assert.equal(pollEvents.length, 2);
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0]?.result.includes("20"), true);

  for (const event of [...pollEvents, ...progressEvents, ...statusEvents]) {
    assert.notEqual(event.result, "");
    assert.notEqual(event.condition, "");
    assert.ok(event.createdAt instanceof Date);
  }

  // AC2：a 成功后，b 不再「等待依赖」，而是变成可以投递的「待投递」；c 还在等 b。
  const staged = await stagesOf(seeded.releaseId);
  assert.equal(staged.get(pkgName("b")), "待投递");
  assert.equal(staged.get(pkgName("c")), "等待依赖");

  const stagedView = await loadBuildQueue(fixture.workspaceId);
  const stagedRelease = stagedView.releases.find((item) => item.releaseId === seeded.releaseId);
  assert.deepEqual(
    stagedRelease?.tasks.find((task) => task.packageName === pkgName("b"))?.waitingFor,
    [],
  );

  const progressed = await seedRelease({
    version: "a14-ac12-dispatch",
    status: "building",
    topicId: 90_011,
    snapshots: [
      { suffix: "a", status: "success", crpReleaseId: 5_002, crpBuildId: 2_002 },
      { suffix: "b", status: "dispatching" },
      { suffix: "c", status: "pending" },
    ],
  });
  const afterDispatch = await stagesOf(progressed.releaseId);
  assert.equal(afterDispatch.get(pkgName("b")), "投递中");
  assert.equal(afterDispatch.get(pkgName("c")), "等待依赖");
});

// ---------------------------------------------------------------------------
// AC3：已完结的提测不再被轮询
// ---------------------------------------------------------------------------

test("AC3 已完结的提测不再轮询，一条 CRP 请求都不发", async () => {
  await closeLeftoverReleases();

  const topicId = 90_002;
  const state = newFakeState(topicId);
  const network = networkOf(state);

  const finished = await seedRelease({
    version: "a14-ac3-finished",
    status: "success",
    topicId,
    snapshots: [
      {
        suffix: "a",
        status: "success",
        crpReleaseId: 5_101,
        crpBuildId: 2_101,
        buildTask: { status: "success", startedAt: new Date(), finishedAt: new Date() },
        jobs: [{ arch: "amd64", status: "success" }],
      },
    ],
  });

  const running = await seedRelease({
    version: "a14-ac3-running",
    status: "building",
    topicId: 90_003,
    snapshots: [
      {
        suffix: "a",
        status: "building",
        crpReleaseId: 5_102,
        crpBuildId: 2_102,
        buildTask: { status: "building", shuttleTaskId: "2102", startedAt: new Date() },
        jobs: [{ arch: "amd64", status: "building" }],
      },
    ],
  });

  state.topicId = 90_003;
  stageBuildInChain(state, 5_102, 2_102, "a");

  const expectedCount = await activeReleaseCount();
  const summary = await runBuildPoll({ trigger: "schedule", network });

  // 已完结的那条不在本轮名单里，在跑的那条在。
  assert.equal(summary.releaseCount, expectedCount);
  assert.equal(
    summary.items.some((item) => item.releaseId === finished.releaseId),
    false,
    "已完结的提测不该出现在本轮名单里",
  );
  assert.equal(
    summary.items.some((item) => item.releaseId === running.releaseId),
    true,
  );

  // 也没有为它发过任何请求（topic 90_002 一次都没出现）。
  assert.deepEqual(
    state.received.filter((item) => item.includes(`/topics/${topicId}/`)),
    [],
  );

  // 它的工作流进度既没被改，也没被同步过。
  const finishedRow = await releaseRow(finished.releaseId);
  assert.equal(finishedRow.crpWorkProgress, null);
  assert.equal(finishedRow.crpWorkProgressSyncedAt, null);

  // 队列页也不列它。
  const view = await loadBuildQueue(fixture.workspaceId);
  assert.equal(
    view.releases.some((item) => item.releaseId === finished.releaseId),
    false,
  );
});

// ---------------------------------------------------------------------------
// AC4：轮询失败不改状态，只记同步错误
// ---------------------------------------------------------------------------

test("AC4 Shuttle 超时：提测与构建状态不变，流水留下同步错误", async () => {
  await closeLeftoverReleases();

  const topicId = 90_004;
  const state = newFakeState(topicId);
  const network = networkOf(state);

  const seeded = await seedRelease({
    version: "a14-ac4",
    status: "building",
    topicId,
    snapshots: [
      {
        suffix: "a",
        status: "building",
        crpReleaseId: 5_201,
        crpBuildId: 2_201,
        buildTask: { status: "building", shuttleTaskId: "2201", startedAt: new Date() },
        jobs: [{ arch: "amd64", status: "building" }],
      },
    ],
  });

  stageBuildInChain(state, 5_201, 2_201, "a");
  state.shuttleDown = true;

  const summary = await runBuildPoll({ trigger: "schedule", network });
  const item = summary.items.find((entry) => entry.releaseId === seeded.releaseId);

  assert.ok(item !== undefined);
  assert.notEqual(item.error, null);
  assert.equal(summary.failed >= 1, true);

  // MUST：查不到不等于构建失败。提测状态与构建状态都保持原样。
  const release = await releaseRow(seeded.releaseId);
  assert.equal(release.status, "building");
  assert.equal((await snapshotStatuses(seeded.releaseId)).get(pkgName("a")), "building");

  const task = await prisma.buildTask.findFirstOrThrow({
    where: { releaseId: seeded.releaseId },
    select: { status: true, statusReason: true },
  });
  assert.equal(task.status, "building");
  assert.equal(task.statusReason, null);

  // 同步错误留在流水里，页面看得到。
  const events = await listPollEvents(fixture.workspaceId, 100);
  const failedPoll = events.find(
    (item) => item.event === "poll" && item.releaseId === seeded.releaseId,
  );
  assert.ok(failedPoll !== undefined);
  assert.equal(failedPoll.result.startsWith("失败："), true);
  assert.equal(failedPoll.result.includes("构建状态保持原样"), true);
  assert.equal(failedPoll.condition, "周期到期");
});

// ---------------------------------------------------------------------------
// MUST：取不到工作流进度时保留旧值，绝不写 0
// ---------------------------------------------------------------------------

test("MUST 取不到工作流进度时保留上一次的值，不写 0", async () => {
  await closeLeftoverReleases();

  const topicId = 90_005;
  const state = newFakeState(topicId);
  const network = networkOf(state);

  const seeded = await seedRelease({
    version: "a14-progress-keep",
    status: "building",
    topicId,
    // 上一次轮询已经写成 20（已转测）。
    workProgress: 20,
    snapshots: [
      {
        suffix: "a",
        status: "success",
        crpReleaseId: 5_301,
        crpBuildId: 2_301,
        buildTask: { status: "success", startedAt: new Date(), finishedAt: new Date() },
        jobs: [{ arch: "amd64", status: "success" }],
      },
    ],
  });

  stageBuildInChain(state, 5_301, 2_301, "a");
  // CRP 回全零对象：这是「取不到工作流信息」，不是「进度回到未开始」。
  state.workflow = { TopicID: 0, WorkProgress: 0 };

  const summary = await runBuildPoll({ trigger: "schedule", network });
  const item = summary.items.find((entry) => entry.releaseId === seeded.releaseId);

  assert.ok(item !== undefined);
  assert.equal(item.workProgress, null);
  assert.notEqual(item.error, null);

  const release = await releaseRow(seeded.releaseId);
  assert.equal(release.crpWorkProgress, 20, "取不到时必须保留上一次的值，不能写 0");

  const events = await listPollEvents(fixture.workspaceId, 100);
  const progressEvent = events.find(
    (item) => item.event === "progress" && item.releaseId === seeded.releaseId,
  );
  assert.ok(progressEvent !== undefined);
  assert.equal(progressEvent.result.startsWith("失败："), true);
  assert.equal(progressEvent.result.includes("保留上一次的值 20"), true);
});

// ---------------------------------------------------------------------------
// 功能检测返工：活跃提测多于单页 / 单轮上限时，最新投递的提测不能被截掉
// ---------------------------------------------------------------------------

test("QA-AC1 活跃提测超过 20 条时，最新投递的那条也在队列页，统计卡算全量", async () => {
  await closeLeftoverReleases();

  const seeded: string[] = [];

  for (let index = 1; index <= 21; index += 1) {
    const row = await seedRelease({
      version: `a14-cap-${index}`,
      status: "building",
      topicId: null,
      snapshots: [{ suffix: "a", status: "pending" }],
    });

    seeded.push(row.releaseId);
  }

  const newest = seeded.at(-1);
  assert.ok(newest !== undefined);

  const view = await loadBuildQueue(fixture.workspaceId);

  assert.equal(view.releases[0]?.releaseId, newest, "刚投递的排在最前");
  assert.equal(view.releases.length, 21, "21 条活跃提测全部列出，不按条数截断");
  assert.equal(view.stats.queued, 21, "统计卡算全部活跃提测，不是只算前几条");
});

test("QA-AC5 活跃提测多于单轮上限时轮流轮到，最新投递的一定会被轮询到", async () => {
  await closeLeftoverReleases();

  // 没有 Topic、没有投递包的提测：轮询它们不发任何网络请求，只验「这一轮挑了谁」。
  const state = newFakeState(90_120);
  const network = networkOf(state);
  const seeded: string[] = [];

  for (const index of [1, 2, 3, 4]) {
    const row = await seedRelease({
      version: `a14-rotate-${index}`,
      status: "pending",
      topicId: null,
      snapshots: [{ suffix: "a", status: "pending" }],
    });

    seeded.push(row.releaseId);
  }

  const newest = seeded.at(-1);
  assert.ok(newest !== undefined);

  // 单轮只处理 3 条：第一轮的名额被更早的提测占满，最新这条轮不到。
  const first = await runBuildPoll({ trigger: "schedule", network, limit: 3 });

  assert.equal(first.items.length, 3);
  assert.equal(first.items.some((item) => item.releaseId === newest), false);

  // 继续跑：轮询按「最久没被轮询的优先」挑活，所以每一条活跃提测最终都会被轮到。
  // 老实现按创建时间取最早的 N 条，最新这条永远轮不到，这个循环会跑空。
  const polled = new Set(first.items.map((item) => item.releaseId));
  let rounds = 0;

  while (!seeded.every((id) => polled.has(id)) && rounds < 6) {
    const summary = await runBuildPoll({ trigger: "schedule", network, limit: 3 });

    for (const item of summary.items) {
      polled.add(item.releaseId);
    }

    rounds += 1;
  }

  assert.equal(
    seeded.every((id) => polled.has(id)),
    true,
    `轮转应在几轮内轮到每一条活跃提测（实际跑了 ${rounds} 轮）`,
  );

  // 被轮询过的都留下标记；不标记的话它会一直占住队首，把别的提测饿死。
  const rows = await prisma.release.findMany({
    where: { id: { in: seeded } },
    select: { lastPolledAt: true },
  });

  assert.equal(rows.length, 4);
  assert.equal(rows.every((row) => row.lastPolledAt !== null), true);
});

// ---------------------------------------------------------------------------
// 详情页区块的读模型
// ---------------------------------------------------------------------------

test("BuildStatusBlock 的读模型给出阶段、架构状态与耗时", async () => {
  await closeLeftoverReleases();

  const seeded = await seedRelease({
    version: "a14-block",
    status: "building",
    topicId: 90_006,
    workProgress: 10,
    snapshots: [
      {
        suffix: "a",
        status: "building",
        crpReleaseId: 5_401,
        crpBuildId: 2_401,
        buildTask: { status: "building", shuttleTaskId: "2401", startedAt: new Date(Date.now() - 120_000) },
        jobs: [
          { arch: "amd64", status: "success" },
          { arch: "arm64", status: "building" },
        ],
      },
      { suffix: "b", status: "pending" },
    ],
  });

  const view = await loadReleaseBuildStatus(seeded.releaseId);

  assert.ok(view !== null);
  assert.equal(view.statusLabel, "构建中");
  assert.equal(view.workProgress, 10);

  const task = view.tasks.find((item) => item.packageName === pkgName("a"));
  assert.ok(task !== undefined);
  assert.equal(task.stage, "构建中");
  assert.deepEqual(task.arches, [
    { arch: "amd64", status: "success" },
    { arch: "arm64", status: "building" },
  ]);
  assert.ok(task.durationMs !== null && task.durationMs >= 120_000);

  const waiting = view.tasks.find((item) => item.packageName === pkgName("b"));
  assert.equal(waiting?.stage, "等待依赖");

  assert.equal(await loadReleaseBuildStatus("00000000-0000-0000-0000-000000000000"), null);
});

// ---------------------------------------------------------------------------
// 定时入口鉴权
// ---------------------------------------------------------------------------

test("定时入口：没配 token 一律 401，填错 token 也是 401", async () => {
  const saved = process.env.BUILD_POLL_JOB_TOKEN;

  try {
    delete process.env.BUILD_POLL_JOB_TOKEN;

    const missing = await pollJobPost(
      new Request("http://localhost/api/jobs/build-poll", { method: "POST" }),
    );
    assert.equal(missing.status, 401);

    process.env.BUILD_POLL_JOB_TOKEN = "zz883-sync-token";

    const wrong = await pollJobPost(
      new Request("http://localhost/api/jobs/build-poll", {
        method: "POST",
        headers: { Authorization: "Bearer zza14-other-token" },
      }),
    );
    assert.equal(wrong.status, 401);
  } finally {
    if (saved === undefined) {
      delete process.env.BUILD_POLL_JOB_TOKEN;
    } else {
      process.env.BUILD_POLL_JOB_TOKEN = saved;
    }
  }
});
