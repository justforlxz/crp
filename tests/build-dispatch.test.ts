/**
 * 投递与构建回写的集成测试：连真数据库，网络层换成假的 CRP / Shuttle。
 *
 * 走的是生产代码的完整链路 —— `advanceRelease` → CRP 客户端（含请求层、重试、调用记录）
 * → `crp_call_log`；只有最后一步 HTTP 被替换掉，因为真实 CRP 不能出现在测试里。
 *
 * 锁住本节点的验收标准：
 *
 * - AC1：三层链 `a → b → c` 的投递顺序是 a、b、c，且 b 只在 a 构建成功之后才发起；
 * - AC2：a 构建失败时 b、c 不发起，提测判 `failed`，Webhook 收到构建失败事件；
 * - AC3：重复触发不会产生第二个 Topic；
 * - AC4：每个包的投递参数与 CRP Release ID 都能查到。
 *
 * 另外锁住两条 MUST：「每次对 CRP 的调用都有请求记录」与「上游失败必须阻断下游」。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";

import { GET } from "../app/api/releases/[id]/dispatch/route";
import { advanceRelease, cancelRelease, listCrpCallLogs, loadReleaseDispatch, retryFailedTasks } from "../lib/build";
import { prisma } from "../lib/db";
import { createRelease } from "../lib/releases";
import { waitForWebhookDeliveries } from "../lib/webhook";

const PREFIX = "zza12";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
/** 基线在 CRP 侧的分支 ID，必须是数字：建 Topic 要用它。 */
const CRP_BRANCH_ID = "8861208";

const CRP_BASE = "https://crp.example.test/api";
const SHUTTLE_BASE = "https://shuttle.example.test/api/shuttle";

const SHA_A = "aaaa0000000000000000000000000000000000001";
const SHA_B = "bbbb0000000000000000000000000000000000002";
const SHA_C = "cccc0000000000000000000000000000000000003";
/** 与依赖链无关的包 d 的提交号：用来验「一个包失败时，另一个还在构建的包不能被判掉」。 */
const SHA_D = "dddd0000000000000000000000000000000000004";

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

function shaFor(suffix: string): string {
  if (suffix === "a") {
    return SHA_A;
  }

  if (suffix === "b") {
    return SHA_B;
  }

  return suffix === "d" ? SHA_D : SHA_C;
}

// ---------------------------------------------------------------------------
// 假的 CRP
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

type FakeCrp = {
  nextTopicId: number;
  nextReleaseId: number;
  nextBuildId: number;
  nextJobId: number;
  topics: Map<number, { name: string; abandoned: boolean }>;
  releases: FakeRelease[];
  builds: Map<number, FakeBuild>;
  /** 收到的每一个 CRP 请求，按发生顺序。用来核对「每次调用都有记录」。 */
  received: string[];
  /** 这些 Release ID 的删除请求会失败，用来验重试时的逐项容错。 */
  failDelete: Set<number>;
};

/** 每个测试用一段独立的 ID 区间：Topic、Release、构建任务的 ID 在库里都是唯一的。 */
let fakeIdBase = 31_000;

function newFakeCrp(): FakeCrp {
  const base = fakeIdBase;
  fakeIdBase += 1_000;

  return {
    nextTopicId: base,
    nextReleaseId: base * 10 + 1,
    nextBuildId: base * 10 + 2,
    nextJobId: base * 10 + 3,
    topics: new Map(),
    releases: [],
    builds: new Map(),
    received: [],
    failDelete: new Set(),
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
function crpFetchOf(state: FakeCrp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    state.received.push(`${method} ${path}`);

    if (method === "GET" && path === "/user") {
      return json(JSON.stringify({ Name: "crp-user", NameCN: "CRP 用户" }));
    }

    if (method === "POST" && path === `/branches/${CRP_BRANCH_ID}/topics`) {
      const topicId = state.nextTopicId++;
      const body = JSON.parse(String(init?.body)) as { Name: string };

      state.topics.set(topicId, { name: body.Name, abandoned: false });

      // 实测：建 Topic 返回 201 + 裸数字。
      return json(String(topicId), 201);
    }

    if (method === "POST" && path === "/project") {
      const body = JSON.parse(String(init?.body)) as { name: string };

      // 实测：按名字模糊匹配，这里只回完全同名的一条。
      return json(JSON.stringify({ Projects: [{ ID: 800, Name: body.name }] }));
    }

    const newRelease = /^\/topics\/(\d+)\/new_release$/.exec(path);

    if (method === "POST" && newRelease !== null) {
      const body = JSON.parse(String(init?.body)) as {
        TopicID: number;
        ProjectID: number;
        ProjectName: string;
        Branch: string;
        Commit: string;
        Tag: string;
      };

      const jobId = state.nextJobId++;
      const buildId = state.nextBuildId++;
      const release: FakeRelease = {
        ID: state.nextReleaseId++,
        TopicID: body.TopicID,
        ProjectID: body.ProjectID,
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

      // 实测：投递 Release 返回 201 + 裸数字。
      return json(String(release.ID), 201);
    }

    const listReleases = /^\/topics\/(\d+)\/releases$/.exec(path);

    if (method === "GET" && listReleases !== null) {
      const topicId = Number(listReleases[1]);

      return json(JSON.stringify(state.releases.filter((item) => item.TopicID === topicId)));
    }

    const deleteRelease = /^\/topic_releases\/(\d+)$/.exec(path);

    if (method === "DELETE" && deleteRelease !== null) {
      const releaseId = Number(deleteRelease[1]);

      if (state.failDelete.has(releaseId)) {
        return json(JSON.stringify({ message: "delete failed" }), 500);
      }

      state.releases = state.releases.filter((item) => item.ID !== releaseId);

      return json(JSON.stringify({ code: "http.StatusOK", status: "success" }));
    }

    const topic = /^\/topics\/(\d+)$/.exec(path);

    if (method === "GET" && topic !== null) {
      return json(
        JSON.stringify({
          ID: Number(topic[1]),
          Owner: [{ name: "crp-user", namecn: "CRP 用户" }],
          Members: null,
          Abandoned: false,
          Completed: false,
        }),
      );
    }

    if (method === "PUT" && topic !== null) {
      const entry = state.topics.get(Number(topic[1]));

      if (entry !== undefined) {
        entry.abandoned = true;
      }

      return json(JSON.stringify({ status: "success" }));
    }

    return json(JSON.stringify({ message: `测试没有实现 ${method} ${path}` }), 404);
  }) as typeof fetch;
}

/** 让某个包之后的构建查询返回指定状态。 */
function setBuild(state: FakeCrp, packageName: string, task: string, jobStatus: string): void {
  for (const release of state.releases) {
    if (release.ProjectName !== packageName) {
      continue;
    }

    const build = state.builds.get(release.BuildID);

    if (build === undefined) {
      continue;
    }

    build.task = task;
    build.jobs = build.jobs.map((job) => ({ ...job, status: jobStatus }));
  }
}

/** 按投递发生的先后列出包名。CRP 侧 Release 的追加顺序就是投递顺序。 */
function dispatchOrder(state: FakeCrp): string[] {
  return state.releases.map((item) => item.ProjectName);
}

// ---------------------------------------------------------------------------
// 假的 Shuttle
// ---------------------------------------------------------------------------

function shuttleFetchOf(state: FakeCrp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Shuttle 的接口前缀是 `/api/shuttle`，比 CRP 多一段。
    const path = new URL(url).pathname.replace(/^\/api\/shuttle/, "");

    if (path !== "/task/list") {
      return json(JSON.stringify({ message: `测试没有实现 ${path}` }), 404);
    }

    const body = JSON.parse(String(init?.body)) as {
      params: { taskid: string } | null;
    };
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

// ---------------------------------------------------------------------------
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
  managerId: string;
  projectId: string;
  /** 四个包（其中 d 与依赖链无关）的项目，用来验「一个包失败时另一个还在构建」。 */
  independentProjectId: string;
};

let fixture: Fixture;
let receiver: Server;
let receivedBodies: Array<Record<string, unknown>> = [];

/**
 * 代码版本按提交号给出：不同提交拿到不同版本，才能证明快照记的是所选提交。
 *
 * 版本号必须是 CRP 接受的形式（数字开头、不含 `-` `_` 空格），
 * 因为快照的 `releaseVersion` 会被原样当作 CRP 的 Tag 投出去。
 */
const CODE_VERSIONS: Record<string, string> = {
  [SHA_A]: "1.0.1",
  [SHA_B]: "1.0.2",
  [SHA_C]: "1.0.3",
  [SHA_D]: "1.0.4",
};

function codeVersionOf(commitSha: string): string {
  return CODE_VERSIONS[commitSha] ?? "1.0.0";
}

const reader = {
  async readCodeVersion(_repoPath: string, commitSha: string): Promise<string> {
    return codeVersionOf(commitSha);
  },
};

async function cleanup(): Promise<void> {
  const baselines = await prisma.baseline.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const baselineIds = baselines.map((item) => item.id);

  // 按工作区找项目：基线的 crpBranchId 是纯数字（建 Topic 要用数字），不能用它前缀匹配。
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

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId: { in: releaseIds } },
    select: { id: true },
  });
  const snapshotIds = snapshots.map((item) => item.id);

  await prisma.crpCallLog.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.buildJob.deleteMany({ where: { buildTask: { releaseId: { in: releaseIds } } } });
  await prisma.buildTask.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });

  // 自关联外键：先解除被替换指向，再删行。
  await prisma.releasePackageSnapshot.updateMany({
    where: { id: { in: snapshotIds } },
    data: { supersededById: null },
  });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });
  await prisma.baselinePackageVersion.deleteMany({ where: { baselineId: { in: baselineIds } } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });

  await prisma.webhookDelivery.deleteMany({
    where: { endpoint: { workspace: { slug: WORKSPACE_SLUG } } },
  });
  await prisma.webhookEndpoint.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.membership.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });

  await prisma.packageDependency.deleteMany({
    where: {
      OR: [
        { package: { name: { startsWith: PREFIX } } },
        { upstreamPackage: { name: { startsWith: PREFIX } } },
      ],
    },
  });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
    data: {
      crpBranchId: CRP_BRANCH_ID,
      name: `${PREFIX}-baseline`,
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  // 三层依赖链：b 依赖 a，c 依赖 b。投递顺序必须是 a → b → c。
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

  const packageD = await prisma.package.create({
    data: { name: pkgName("d"), repoPath: `${PREFIX}/d`, defaultBranch: "develop/eagle" },
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

  for (const packageId of [packageA.id, packageB.id, packageC.id]) {
    await prisma.projectSoftware.create({
      data: { projectId: project.id, packageId, trackedBranch: "develop/eagle" },
    });
  }

  const independentProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-independent`,
      name: `${PREFIX} 独立包项目`,
    },
    select: { id: true },
  });

  for (const packageId of [packageA.id, packageB.id, packageC.id, packageD.id]) {
    await prisma.projectSoftware.create({
      data: { projectId: independentProject.id, packageId, trackedBranch: "develop/eagle" },
    });
  }

  // Webhook 接收端：真起一个本地 HTTP 服务，才能断言「接收端确实收到了事件」。
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200).end("ok");
    });
  });

  await new Promise<void>((resolve) => {
    receiver.listen(0, "127.0.0.1", resolve);
  });

  const address = receiver.address();

  if (address === null || typeof address === "string") {
    throw new Error("测试用的接收端没有拿到端口");
  }

  await prisma.webhookEndpoint.create({
    data: {
      workspaceId: workspace.id,
      name: `${PREFIX}-receiver`,
      url: `http://127.0.0.1:${address.port}/hook`,
      secret: `${PREFIX}-secret`,
      eventTypes: ["build.failed", "build.succeeded", "build.started", "release.status_synced"],
    },
  });

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    managerId: manager.id,
    projectId: project.id,
    independentProjectId: independentProject.id,
  };
});

after(async () => {
  await waitForWebhookDeliveries();

  if (receiver !== undefined) {
    await new Promise<void>((resolve) => {
      receiver.close(() => resolve());
    });
  }

  await cleanup();
  await prisma.$disconnect();
});

/** 建一条提测：三个包都进快照，顺序按依赖拓扑排序（a、b、c）。 */
async function createReleaseWithChain(version: string): Promise<string> {
  const created = await createRelease(
    {
      projectId: fixture.projectId,
      version,
      description: null,
      packages: ["a", "b", "c"].map((suffix) => ({
        packageName: pkgName(suffix),
        branch: "develop/eagle",
        commitSha: shaFor(suffix),
        customTag: null,
      })),
    },
    { createdById: fixture.userId, reader },
  );

  assert.deepEqual(created.order, [pkgName("a"), pkgName("b"), pkgName("c")]);

  return created.id;
}

/** 建一条含独立包 d 的提测：依赖链 a→b→c 之外还有一个互不依赖的 d。 */
async function createIndependentRelease(version: string): Promise<string> {
  const created = await createRelease(
    {
      projectId: fixture.independentProjectId,
      version,
      description: null,
      packages: ["a", "b", "c", "d"].map((suffix) => ({
        packageName: pkgName(suffix),
        branch: "develop/eagle",
        commitSha: shaFor(suffix),
        customTag: null,
      })),
    },
    { createdById: fixture.userId, reader },
  );

  return created.id;
}

/** 读一条提测当前轮每个包的快照状态。 */
async function snapshotStatuses(releaseId: string): Promise<Map<string, string>> {
  const rows = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { packageName: true, status: true },
  });

  return new Map(rows.map((row) => [row.packageName, row.status]));
}

/** 一轮「真请求层 + 假网络」的推进。 */
function networkOf(state: FakeCrp) {
  return {
    crpBaseUrl: CRP_BASE,
    crpToken: "test-token",
    crpFetch: crpFetchOf(state),
    shuttleBaseUrl: SHUTTLE_BASE,
    shuttleFetch: shuttleFetchOf(state),
  };
}

// ---------------------------------------------------------------------------
// AC1：三层依赖链按序投递，b 只在 a 成功后发起
// ---------------------------------------------------------------------------

test("AC1 三层依赖链按 a、b、c 投递，b 只在 a 构建成功后才发起", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("ac1");

  const topic = await advanceRelease(releaseId, { network });
  assert.equal(topic.action, "topic_created");
  assert.equal(topic.status, "dispatching");

  const first = await advanceRelease(releaseId, { network });
  assert.equal(first.action, "dispatched");
  assert.equal(first.packageName, pkgName("a"));

  // a 还在构建：这一轮什么也不投，b 没有资格发起。
  const waiting = await advanceRelease(releaseId, { network });
  assert.equal(waiting.action, "waiting");
  assert.equal(waiting.polled?.building.includes(pkgName("a")), true);
  assert.deepEqual(dispatchOrder(state), [pkgName("a")]);

  // a 构建成功后，b 才被投递。
  setBuild(state, pkgName("a"), "BUILD_OK", "BUILD_OK");
  const second = await advanceRelease(releaseId, { network });
  assert.equal(second.action, "dispatched");
  assert.equal(second.packageName, pkgName("b"));
  assert.deepEqual(dispatchOrder(state), [pkgName("a"), pkgName("b")]);

  setBuild(state, pkgName("b"), "BUILD_OK", "BUILD_OK");
  const third = await advanceRelease(releaseId, { network });
  assert.equal(third.action, "dispatched");
  assert.equal(third.packageName, pkgName("c"));

  setBuild(state, pkgName("c"), "BUILD_OK", "BUILD_OK");
  const finished = await advanceRelease(releaseId, { network });
  assert.equal(finished.action, "finished");
  assert.equal(finished.status, "success");

  // 投递顺序就是 a、b、c：CRP 侧 Release 的追加顺序可直接核对。
  assert.deepEqual(dispatchOrder(state), [pkgName("a"), pkgName("b"), pkgName("c")]);

  // 每个包都投的是快照里的分支与 Commit，没有回查仓库。
  assert.deepEqual(
    state.releases.map((item) => [item.ProjectName, item.Branch, item.Commit]),
    [
      [pkgName("a"), "develop/eagle", SHA_A],
      [pkgName("b"), "develop/eagle", SHA_B],
      [pkgName("c"), "develop/eagle", SHA_C],
    ],
  );

  const tasks = await prisma.buildTask.findMany({
    where: { releaseId },
    select: { status: true, snapshot: { select: { packageName: true } } },
  });

  assert.deepEqual(
    tasks.map((item) => [item.snapshot.packageName, item.status]).sort(),
    [
      [pkgName("a"), "success"],
      [pkgName("b"), "success"],
      [pkgName("c"), "success"],
    ],
  );

  // MUST：每一次 CRP 调用都有记录，一条不少。
  const logs = await listCrpCallLogs(releaseId, 200);

  assert.equal(logs.length, state.received.length, "调用记录条数应与真实发出的请求数一致");

  const dispatchLogs = logs.filter((item) => item.url.endsWith("/new_release"));

  assert.equal(dispatchLogs.length, 3);
  assert.deepEqual(
    dispatchLogs.map((item) => item.packageName).sort(),
    [pkgName("a"), pkgName("b"), pkgName("c")],
  );

  for (const log of logs) {
    assert.ok(log.statusCode === 200 || log.statusCode === 201, `${log.method} ${log.url} 应记到状态码`);
    assert.ok(log.durationMs >= 0, "耗时应被记录");
  }

  for (const log of dispatchLogs) {
    assert.equal(log.statusCode, 201, "投递 Release 应记到 201");
  }
});

// ---------------------------------------------------------------------------
// AC2：上游失败阻断下游、提测判失败、Webhook 收到构建失败事件
// ---------------------------------------------------------------------------

test("AC2 a 构建失败时 b、c 不投递，提测判失败，Webhook 收到构建失败事件", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("ac2");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  receivedBodies = [];

  setBuild(state, pkgName("a"), "UPLOAD_GIVEUP", "FAILED");
  const result = await advanceRelease(releaseId, { network });

  assert.equal(result.action, "finished");
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.blocked.map((item) => item.packageName).sort(),
    [pkgName("b"), pkgName("c")],
  );

  // b、c 一条 Release 都没发出去。
  assert.deepEqual(dispatchOrder(state), [pkgName("a")]);

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { status: true },
  });
  assert.equal(release.status, "failed");

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { id: true, packageName: true, status: true },
  });
  assert.deepEqual(
    snapshots.map((item) => [item.packageName, item.status]).sort(),
    [
      [pkgName("a"), "failed"],
      [pkgName("b"), "failed"],
      [pkgName("c"), "failed"],
    ],
  );

  // 阻断可解释：b、c 的构建任务写明是被 a 阻断的。
  const snapshotA = snapshots.find((item) => item.packageName === pkgName("a"));

  const blockedTasks = await prisma.buildTask.findMany({
    where: { releaseId, blockedBySnapshotId: { not: null } },
    select: { blockedBySnapshotId: true, status: true, statusReason: true, snapshot: { select: { packageName: true } } },
  });

  assert.equal(blockedTasks.length, 2);

  for (const task of blockedTasks) {
    assert.equal(task.blockedBySnapshotId, snapshotA?.id);
    assert.equal(task.status, "failed");
    assert.match(task.statusReason ?? "", new RegExp(`因上游 ${pkgName("a")} 构建失败而阻断`));
  }

  // Webhook 接收端确实收到了构建失败事件，a 与两个被阻断的包各一条。
  await waitForWebhookDeliveries();

  const failures = receivedBodies.filter((body) => body.type === "build.failed");

  assert.equal(failures.length, 3);

  const failedPackages = failures.map(
    (body) => (body.data as { packageName: string }).packageName,
  );

  assert.deepEqual(failedPackages.sort(), [pkgName("a"), pkgName("b"), pkgName("c")]);

  const delivered = await prisma.webhookDelivery.count({
    where: { eventType: "build.failed", status: "success" },
  });
  assert.ok(delivered >= 3, "构建失败事件应成功投递到接收端");
});

// ---------------------------------------------------------------------------
// AC3：重复触发不产生第二个 Topic
// ---------------------------------------------------------------------------

test("AC3 重复触发不会产生第二个 Topic", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("ac3");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const topicCreates = state.received.filter(
    (item) => item === `POST /branches/${CRP_BRANCH_ID}/topics`,
  );

  assert.equal(topicCreates.length, 1, "建 Topic 的请求只能发一次");
  assert.equal(state.topics.size, 1, "CRP 侧只能有一个 Topic");

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { crpTopicId: true, crpBranchId: true },
  });

  assert.equal(release.crpTopicId, String(state.nextTopicId - 1));
  assert.equal(release.crpBranchId, CRP_BRANCH_ID);

  // 已走到终局的提测再触发什么也不做，更不会建 Topic。
  await advanceRelease(releaseId, { network });

  assert.equal(
    state.received.filter((item) => item === `POST /branches/${CRP_BRANCH_ID}/topics`).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// AC4：详情能看到投递参数与 CRP Release ID
// ---------------------------------------------------------------------------

test("AC4 接口能看到每个包的投递参数与 CRP Release ID", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("ac4");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  // b 的投递要等 a 成功，这样两个包都有 CRP Release ID。
  setBuild(state, pkgName("a"), "BUILD_OK", "BUILD_OK");
  await advanceRelease(releaseId, { network });

  const view = await loadReleaseDispatch(releaseId);

  assert.equal(view.crpTopicId, String(Number(state.releases[0]?.TopicID)));
  assert.equal(view.crpBranchId, CRP_BRANCH_ID);

  const packageA = view.packages.find((item) => item.packageName === pkgName("a"));
  const packageB = view.packages.find((item) => item.packageName === pkgName("b"));

  assert.ok(packageA !== undefined && packageB !== undefined);

  assert.equal(packageA.branch, "develop/eagle");
  assert.equal(packageA.commitSha, SHA_A);
  assert.equal(packageA.releaseVersion, codeVersionOf(SHA_A));
  assert.equal(packageA.crpReleaseId, String(state.releases[0]?.ID));
  assert.equal(packageA.crpBuildId, String(state.releases[0]?.BuildID));

  assert.equal(packageB.commitSha, SHA_B);
  assert.equal(packageB.crpReleaseId, String(state.releases[1]?.ID));

  // 还没投递的包没有 CRP Release ID，不能编一个出来。
  const packageC = view.packages.find((item) => item.packageName === pkgName("c"));
  assert.equal(packageC?.crpReleaseId, null);

  // 顺序按包名排列，与快照的读取顺序一致。
  assert.deepEqual(
    view.packages.map((item) => item.packageName),
    [pkgName("a"), pkgName("b"), pkgName("c")],
  );

  // 这条提测的 CRP 调用记录同样查得到。
  assert.ok((await listCrpCallLogs(releaseId)).length > 0);
});

test("接口在提测不存在时返回 404", async () => {
  // 带会话调接口需要 Next 的请求上下文，这里只验证「先查归属」这一段的接线：
  // 找不到提测时直接 404，不会走到会话判定，也就不会把「存在过」泄露出去。
  const response = await GET(
    new Request("http://localhost/api/releases/not-a-release/dispatch"),
    { params: Promise.resolve({ id: "not-a-release" }) },
  );

  assert.equal(response.status, 404);

  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "release_not_found");
});

test("重试会删掉旧 Release，并按同一份快照参数重新投递", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("retry");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const oldReleaseId = state.releases[0]?.ID;

  setBuild(state, pkgName("a"), "UPLOAD_GIVEUP", "FAILED");
  await advanceRelease(releaseId, { network });

  const retried = await retryFailedTasks(releaseId, { network });

  assert.deepEqual(retried.resetPackageNames, [pkgName("a")]);
  assert.deepEqual(retried.unblockedPackageNames.sort(), [pkgName("b"), pkgName("c")]);
  assert.deepEqual(retried.advance.action, "dispatched");
  assert.equal(retried.advance.packageName, pkgName("a"));

  // 旧 Release 被删掉，随后按同一份参数重新发了一条。
  assert.equal(
    state.received.filter((item) => item === `DELETE /topic_releases/${oldReleaseId}`).length,
    1,
  );

  const dispatchRequests = state.releases.filter((item) => item.ProjectName === pkgName("a"));
  assert.equal(dispatchRequests.length, 1, "重投后 CRP 侧只应留一条 a 的 Release");

  const latest = dispatchRequests[0];
  assert.equal(latest?.Branch, "develop/eagle");
  assert.equal(latest?.Commit, SHA_A);
  assert.equal(latest?.Tag, codeVersionOf(SHA_A));

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { packageName: true, status: true },
  });

  const byName = new Map(snapshots.map((item) => [item.packageName, item.status]));
  assert.equal(byName.get(pkgName("a")), "building");
  assert.equal(byName.get(pkgName("b")), "pending");
  assert.equal(byName.get(pkgName("c")), "pending");

  const blockedLeft = await prisma.buildTask.count({
    where: { releaseId, blockedBySnapshotId: { not: null } },
  });
  assert.equal(blockedLeft, 0, "重试后不应再留着阻断说明");
});

test("没有失败任务时重试直接拒绝", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("retry-none");

  await advanceRelease(releaseId, { network });

  await assert.rejects(retryFailedTasks(releaseId, { network }), /没有失败的构建任务/);
});

test("取消提测会删掉所有 Release 并放弃 Topic", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("cancel");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const dispatched = state.releases.map((item) => item.ID);
  const topicId = state.releases[0]?.TopicID;

  const cancelled = await cancelRelease(releaseId, { network });

  assert.deepEqual(cancelled.deletedReleaseIds.sort(), dispatched.map(String).sort());
  assert.equal(cancelled.abandonedTopicId, String(topicId));
  assert.deepEqual(cancelled.failures, []);
  assert.equal(state.topics.get(Number(topicId))?.abandoned, true);

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { status: true, crpTopicAbandoned: true },
  });
  assert.equal(release.status, "abandoned");
  assert.equal(release.crpTopicAbandoned, true);

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { status: true },
  });
  assert.deepEqual(
    snapshots.map((item) => item.status),
    ["abandoned", "abandoned", "abandoned"],
  );

  await assert.rejects(cancelRelease(releaseId, { network }), /已经取消过/);
});

// ---------------------------------------------------------------------------
// 并发推进：互斥（AC3 的并发情形）
// ---------------------------------------------------------------------------

test("并发触发同一提测只建一个 Topic", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("concurrent-topic");

  const results = await Promise.all([
    advanceRelease(releaseId, { network }),
    advanceRelease(releaseId, { network }),
  ]);

  // 两次调用里只有一次真的去建 Topic，另一次什么都不做直接返回。
  assert.deepEqual(
    results.map((item) => item.action).sort(),
    ["topic_created", "waiting"],
  );
  assert.equal(state.topics.size, 1, "CRP 侧只能有一个 Topic");
  assert.equal(
    state.received.filter((item) => item === `POST /branches/${CRP_BRANCH_ID}/topics`).length,
    1,
  );
});

test("并发推进不会对同一个包重复投递", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("concurrent-dispatch");

  await advanceRelease(releaseId, { network });

  const results = await Promise.all([
    advanceRelease(releaseId, { network }),
    advanceRelease(releaseId, { network }),
  ]);

  assert.deepEqual(dispatchOrder(state), [pkgName("a")], "同一个包只能发一条 Release");
  assert.equal(
    results.filter((item) => item.action === "dispatched").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// 终局判定：等还在构建的包出结论
// ---------------------------------------------------------------------------

test("一个包失败时，另一个还在构建的包不被判掉，等它出结论再定提测状态", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createIndependentRelease("wait-running");

  await advanceRelease(releaseId, { network });

  const firstDispatch = await advanceRelease(releaseId, { network });
  const secondDispatch = await advanceRelease(releaseId, { network });

  assert.equal(firstDispatch.packageName, pkgName("a"));
  assert.equal(secondDispatch.packageName, pkgName("d"));
  assert.deepEqual(dispatchOrder(state), [pkgName("a"), pkgName("d")]);

  // a 失败，d 还在构建：此时不能判终局，否则 d 的结果再也写不回来。
  setBuild(state, pkgName("a"), "UPLOAD_GIVEUP", "FAILED");
  const waiting = await advanceRelease(releaseId, { network });

  assert.equal(waiting.action, "waiting");
  assert.equal(waiting.status, "building");

  const afterFailure = await snapshotStatuses(releaseId);
  assert.equal(afterFailure.get(pkgName("a")), "failed");
  assert.equal(afterFailure.get(pkgName("d")), "building", "d 还在构建，不能被判掉");
  assert.equal(afterFailure.get(pkgName("b")), "failed");
  assert.equal(afterFailure.get(pkgName("c")), "failed");

  // d 出结论之后才收尾，并且 d 的结果被写回。
  setBuild(state, pkgName("d"), "BUILD_OK", "BUILD_OK");
  const finished = await advanceRelease(releaseId, { network });

  assert.equal(finished.action, "finished");
  assert.equal(finished.status, "partial_failure");

  const tasks = await prisma.buildTask.findMany({
    where: { releaseId },
    select: { status: true, snapshot: { select: { packageName: true } } },
  });
  const byName = new Map(tasks.map((task) => [task.snapshot.packageName, task.status]));

  assert.equal(byName.get(pkgName("d")), "success");
  assert.equal(byName.get(pkgName("a")), "failed");
});

// ---------------------------------------------------------------------------
// 重试的逐项容错
// ---------------------------------------------------------------------------

test("重试时某个包的旧 Release 删不掉，只影响它自己，不留下改了一半的数据", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createIndependentRelease("retry-partial");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  setBuild(state, pkgName("a"), "UPLOAD_GIVEUP", "FAILED");
  setBuild(state, pkgName("d"), "UPLOAD_GIVEUP", "FAILED");
  const failed = await advanceRelease(releaseId, { network });

  assert.equal(failed.status, "failed");

  const releaseA = state.releases.find((item) => item.ProjectName === pkgName("a"));
  assert.ok(releaseA !== undefined);
  state.failDelete.add(releaseA.ID);

  const retried = await retryFailedTasks(releaseId, { network });

  // a 的旧 Release 删不掉，如实记下；d 照常重投。
  assert.deepEqual(retried.resetPackageNames, [pkgName("d")]);
  assert.equal(retried.failures.length, 1);
  assert.equal(retried.failures[0]?.packageName, pkgName("a"));
  assert.match(retried.failures[0]?.reason ?? "", /delete failed/);

  // 状态是一致的：没有留下「提测已失败、却还挂着待投递的包」。
  assert.equal(retried.advance.status, "failed");

  const statuses = await snapshotStatuses(releaseId);

  for (const suffix of ["a", "b", "c", "d"]) {
    assert.equal(statuses.get(pkgName(suffix)), "failed", `${suffix} 应有明确结论`);
  }

  // 删不掉的原因消失后，再点一次重试就能恢复。
  state.failDelete.clear();
  const recovered = await retryFailedTasks(releaseId, { network });

  assert.deepEqual(recovered.resetPackageNames, [pkgName("a")]);
  assert.deepEqual(recovered.unblockedPackageNames.sort(), [
    pkgName("b"),
    pkgName("c"),
    pkgName("d"),
  ]);
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.advance.action, "dispatched");
  assert.equal(recovered.advance.packageName, pkgName("a"));
});

// ---------------------------------------------------------------------------
// 投递中断后的恢复：不能留下只会进、不会出的「投递中」
// ---------------------------------------------------------------------------

/** 把某个包伪装成「投递中途被打断」：本地记录与构建任务都没了，快照停在「投递中」。 */
async function pretendInterrupted(
  releaseId: string,
  packageName: string,
  claimedMinutesAgo: number,
): Promise<{ snapshotId: string }> {
  const snapshot = await prisma.releasePackageSnapshot.findFirstOrThrow({
    where: { releaseId, packageName },
    select: { id: true },
  });

  await prisma.buildTask.deleteMany({ where: { snapshotId: snapshot.id } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { snapshotId: snapshot.id } });
  await prisma.releasePackageSnapshot.update({
    where: { id: snapshot.id },
    data: {
      status: "dispatching",
      updatedAt: new Date(Date.now() - claimedMinutesAgo * 60 * 1000),
    },
  });

  return { snapshotId: snapshot.id };
}

test("投递中断后仍在抢占有效期内时不接手，也不会重复发 Release", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("interrupt-fresh");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const { snapshotId } = await pretendInterrupted(releaseId, pkgName("a"), 0);

  const result = await advanceRelease(releaseId, { network });

  assert.equal(result.action, "waiting");

  const stillClaimed = await prisma.releasePackageSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    select: { status: true },
  });
  assert.equal(stillClaimed.status, "dispatching", "抢占还在有效期内，不该被退回");

  assert.equal(
    state.received.filter((item) => item.endsWith("/new_release")).length,
    1,
    "不能重复投递",
  );
});

test("投递中断且 CRP 已经收下时，接手会补写记录，不会发第二条 Release", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("interrupt-adopt");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const originalRelease = state.releases.find((item) => item.ProjectName === pkgName("a"));
  assert.ok(originalRelease !== undefined);

  const { snapshotId } = await pretendInterrupted(releaseId, pkgName("a"), 10);

  const resumed = await advanceRelease(releaseId, { network });

  // 接手 + 认领：既没有新发 Release，也不再把包留在「投递中」。
  assert.equal(
    state.received.filter((item) => item.endsWith("/new_release")).length,
    1,
    "CRP 侧已经有这一条，不能再发一条",
  );

  const snapshot = await prisma.releasePackageSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    select: { status: true },
  });
  assert.equal(snapshot.status, "building");

  const record = await prisma.releaseRepositoryRecord.findUniqueOrThrow({
    where: { snapshotId },
    select: { crpReleaseId: true },
  });
  assert.equal(record.crpReleaseId, String(originalRelease.ID));

  assert.ok(resumed.polled !== null);

  // 恢复之后链条照常往下走：a 成功后能投 b。
  setBuild(state, pkgName("a"), "BUILD_OK", "BUILD_OK");
  const next = await advanceRelease(releaseId, { network });

  assert.equal(next.action, "dispatched");
  assert.equal(next.packageName, pkgName("b"));
});

test("投递中断且 CRP 侧没有这条 Release 时，接手会重新投递", async () => {
  const state = newFakeCrp();
  const network = networkOf(state);
  const releaseId = await createReleaseWithChain("interrupt-retry");

  await advanceRelease(releaseId, { network });
  await advanceRelease(releaseId, { network });

  const originalRelease = state.releases.find((item) => item.ProjectName === pkgName("a"));
  assert.ok(originalRelease !== undefined);

  // 断在「还没发到 CRP」：CRP 侧没有这条 Release。
  state.releases = state.releases.filter((item) => item.ID !== originalRelease.ID);
  const { snapshotId } = await pretendInterrupted(releaseId, pkgName("a"), 10);

  await advanceRelease(releaseId, { network });

  assert.equal(
    state.received.filter((item) => item.endsWith("/new_release")).length,
    2,
    "CRP 侧没有就重新发一条",
  );
  assert.deepEqual(dispatchOrder(state), [pkgName("a")]);

  const snapshot = await prisma.releasePackageSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    select: { status: true },
  });
  assert.equal(snapshot.status, "building");
});
