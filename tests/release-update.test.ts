/**
 * 提测增量更新的集成测试：连真数据库，网络层换成假的 CRP / Shuttle。
 *
 * 走的是生产代码的完整链路 —— `applyReleaseUpdate` → 现读 CRP 工作流 → 删旧 Release
 * → 写新轮 → `advanceRelease` 重投；只有最后一步 HTTP 被替换掉。
 *
 * 锁住本节点的验收标准：
 *
 * - AC1：补一个依赖「已成功包」的新包，新包排到正确位置并投递，已成功的包不被重投；
 * - AC2：换上游的 Commit，它的全部传递下游（菱形依赖，多层）被放弃并重投，非下游的包不动；
 * - AC3：CRP 工作流进度到 20（已转测）后，更新被拒绝且说明原因；读不到进度同样拒绝；
 * - AC4：对同一提测连发两次更新，CRP 侧不会出现重复 Release；
 * - AC5：注入一次 CRP 删除失败，整次更新中止，提测保持原样、不留半成品数据；
 * - AC6：每轮更新留下「谁、什么时候、加了什么、放弃了什么、重投了什么」。
 *
 * 另外锁住两条 MUST：重投沿用同一个提测版本号（Tag 不变），旧轮标 `superseded` 而不是删掉。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { advanceRelease } from "../lib/build";
import { prisma } from "../lib/db";
import {
  applyReleaseUpdate,
  createRelease,
  loadReleaseUpdateView,
  parseReleaseUpdateInput,
  previewReleaseUpdate,
  RELEASE_UPDATE_ACTION_LABELS,
  ReleaseError,
  releaseUpdateActionLabel,
} from "../lib/releases";

const PREFIX = "zza17";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
/** 基线在 CRP 侧的分支 ID，必须是数字：建 Topic 要用它。 */
const CRP_BRANCH_ID = "8861207";

const CRP_BASE = "https://crp.example.test/api";
const SHUTTLE_BASE = "https://shuttle.example.test/api/shuttle";
const BRANCH = "develop/eagle";

/** 提交号只接受 7–40 位十六进制，这里统一用 40 位。 */
const SHA_A = `${"a".repeat(38)}01`;
const SHA_A2 = `${"a".repeat(38)}02`;
const SHA_B = `${"b".repeat(38)}01`;
const SHA_C = `${"c".repeat(38)}01`;
const SHA_D = `${"d".repeat(38)}01`;
const SHA_E = `${"e".repeat(38)}01`;
const SHA_F = `${"f".repeat(38)}01`;

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

/** 代码版本必须是 CRP Tag 能接受的形式：数字开头、不含 `-` `_` 空格。 */
const CODE_VERSIONS: Record<string, string> = {
  [SHA_A]: "1.0.1",
  [SHA_A2]: "1.0.9",
  [SHA_B]: "1.0.2",
  [SHA_C]: "1.0.3",
  [SHA_D]: "1.0.4",
  [SHA_E]: "1.0.5",
  [SHA_F]: "1.0.6",
};

const reader = {
  async readCodeVersion(_repoPath: string, commitSha: string): Promise<string> {
    return CODE_VERSIONS[commitSha] ?? "1.0.0";
  },
};

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
  received: string[];
  /** 这些 Release ID 的删除请求会失败（AC5 的故障注入）。 */
  failDelete: Set<number>;
  /** `GET /topics/{id}/workflow/info` 返回的进度（AC3）。 */
  workProgress: number;
  /** 让工作流接口报错，验「读不到就拒绝」。 */
  workflowFails: boolean;
};

/** 每个测试用一段独立的 ID 区间：Topic、Release、构建任务的 ID 在库里都是唯一的。 */
let fakeIdBase = 300_000;

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
    workProgress: 0,
    workflowFails: false,
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

      return json(String(topicId), 201);
    }

    const workflow = /^\/topics\/(\d+)\/workflow\/info$/.exec(path);

    if (method === "GET" && workflow !== null) {
      if (state.workflowFails) {
        // 带 message 的响应是 CRP 的明确拒绝，请求层不会重试，测试跑得快。
        return json(JSON.stringify({ message: "workflow unavailable" }), 500);
      }

      return json(JSON.stringify({ TopicID: Number(workflow[1]), WorkProgress: state.workProgress }));
    }

    if (method === "POST" && path === "/project") {
      const body = JSON.parse(String(init?.body)) as { name: string };

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

/** 每个软件包在 CRP 侧还剩几条 Release。 */
function releaseCounts(state: FakeCrp): Map<string, number> {
  const counts = new Map<string, number>();

  for (const release of state.releases) {
    counts.set(release.ProjectName, (counts.get(release.ProjectName) ?? 0) + 1);
  }

  return counts;
}

/** 某个软件包在 CRP 侧最近一次投递的 Release。 */
function latestReleaseOf(state: FakeCrp, packageName: string): FakeRelease | undefined {
  return [...state.releases].reverse().find((item) => item.ProjectName === packageName);
}

// ---------------------------------------------------------------------------
// 假的 Shuttle
// ---------------------------------------------------------------------------

function shuttleFetchOf(state: FakeCrp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname.replace(/^\/api\/shuttle/, "");

    if (path !== "/task/list") {
      return json(JSON.stringify({ message: `测试没有实现 ${path}` }), 404);
    }

    const body = JSON.parse(String(init?.body)) as { params: { taskid: string } | null };
    const build = body.params === null ? undefined : state.builds.get(Number(body.params.taskid));

    if (build === undefined) {
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
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
  managerId: string;
  projectId: string;
  packageIds: Record<string, string>;
};

let fixture: Fixture;

async function cleanup(): Promise<void> {
  const baselines = await prisma.baseline.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const baselineIds = baselines.map((item) => item.id);

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

  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
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
      // 投递用的架构集合来自基线（MKACG-912）：空数组会让投递当场被拒。
      arches: ["amd64", "arm64"],
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  /**
   * 菱形依赖：b、c 依赖 a，d 依赖 b 与 c；e 独立；f 依赖 c（补包用它）。
   *
   *   a ─┬─ b ─┬─ d
   *      └─ c ─┘
   *         └──── f
   */
  const packageIds: Record<string, string> = {};

  for (const suffix of ["a", "b", "c", "d", "e", "f"]) {
    const created = await prisma.package.create({
      data: { name: pkgName(suffix), repoPath: `${PREFIX}/${suffix}`, defaultBranch: BRANCH },
      select: { id: true },
    });

    packageIds[suffix] = created.id;
  }

  for (const [downstream, upstream] of [
    ["b", "a"],
    ["c", "a"],
    ["d", "b"],
    ["d", "c"],
    ["f", "c"],
  ]) {
    await prisma.packageDependency.create({
      data: { packageId: packageIds[downstream], upstreamPackageId: packageIds[upstream] },
    });
  }

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

  // 建提测时清单里是 a…e；f 是之后才进清单的包，正好用来验「补包」。
  for (const suffix of ["a", "b", "c", "d", "e"]) {
    await prisma.projectSoftware.create({
      data: { projectId: project.id, packageId: packageIds[suffix], trackedBranch: BRANCH },
    });
  }

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    managerId: manager.id,
    projectId: project.id,
    packageIds,
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 建一条提测：项目清单里的包全部进快照，顺序按依赖拓扑排序。
 *
 * 清单按当前状态读，不写死 a…e：AC1 会把 f 加进清单（模拟「建提测之后项目又加了包」），
 * 后面几个用例建的提测就得连 f 一起带上，否则建提测本身会被清单一致性挡住。
 */
async function createChainRelease(version: string): Promise<string> {
  const entries = await prisma.projectSoftware.findMany({
    where: { projectId: fixture.projectId },
    select: { package: { select: { name: true } } },
  });

  const created = await createRelease(
    {
      projectId: fixture.projectId,
      version,
      description: null,
      packages: entries.map((item) => {
        const suffix = item.package.name.replace(`${PREFIX}-`, "");

        return {
          packageName: item.package.name,
          branch: BRANCH,
          commitSha: SHA_OF[suffix],
          customTag: null,
        };
      }),
    },
    { createdById: fixture.userId, reader },
  );

  return created.id;
}

const SHA_OF: Record<string, string> = {
  a: SHA_A,
  b: SHA_B,
  c: SHA_C,
  d: SHA_D,
  e: SHA_E,
  f: SHA_F,
};

/** 反复推进直到提测到终局（全部成功）。假 Shuttle 的构建一律标成功。 */
async function dispatchToSuccess(state: FakeCrp, releaseId: string): Promise<void> {
  const network = networkOf(state);

  for (let step = 0; step < 60; step += 1) {
    const result = await advanceRelease(releaseId, { network });

    if (result.action === "finished") {
      return;
    }

    if (result.action === "dispatched" && result.packageName !== null) {
      setBuild(state, result.packageName, "BUILD_OK", "BUILD_OK");
      continue;
    }

    for (const name of result.polled?.building ?? []) {
      setBuild(state, name, "BUILD_OK", "BUILD_OK");
    }
  }

  throw new Error("提测没有在预期步数内跑到终局");
}

function updateOptions(state: FakeCrp) {
  return { operatorId: fixture.userId, reader, network: networkOf(state) };
}

/** 把某个包加进项目清单（建提测之后再加的包，正好用来验补包）。 */
async function addToProject(suffix: string): Promise<void> {
  await prisma.projectSoftware.create({
    data: {
      projectId: fixture.projectId,
      packageId: fixture.packageIds[suffix],
      trackedBranch: BRANCH,
    },
  });
}

/** 当前轮的快照（被替换的旧轮不算）。 */
async function currentSnapshots(releaseId: string) {
  return prisma.releasePackageSnapshot.findMany({
    where: { releaseId, supersededById: null },
    select: {
      id: true,
      packageName: true,
      attempt: true,
      status: true,
      releaseVersion: true,
      commitSha: true,
    },
  });
}

// ---------------------------------------------------------------------------
// AC1：补包只投新包，已成功的包不重投
// ---------------------------------------------------------------------------

test("AC1 补一个依赖已成功包的新包：排到正确位置并投递，已成功的包不重投", async (t) => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac1");
  await dispatchToSuccess(state, releaseId);

  // 用完把 f 从项目清单里撤掉：后面的用例不该因为 AC1 补过包而多出一个包。
  t.after(async () => {
    await prisma.projectSoftware.deleteMany({
      where: { projectId: fixture.projectId, package: { name: pkgName("f") } },
    });
  });

  assert.deepEqual([...releaseCounts(state).keys()].sort(), ["a", "b", "c", "d", "e"].map(pkgName).sort());

  // f 在建提测之后才进项目清单，所以这条提测里还没有它。
  await addToProject("f");

  const beforeF = state.releases.length;

  const result = await applyReleaseUpdate(
    releaseId,
    {
      append: [{ packageName: pkgName("f"), branch: BRANCH, commitSha: SHA_F, customTag: null }],
      replace: [],
    },
    updateOptions(state),
  );

  assert.deepEqual(result.plan.appendedPackageNames, [pkgName("f")]);
  assert.deepEqual(result.plan.abandoned, []);
  assert.equal(result.plan.revisionAfter, 2);

  // f 的上游 c 已经成功，所以这次更新就把它投出去了。
  assert.equal(result.advance?.packageName, pkgName("f"));
  assert.equal(state.releases.length, beforeF + 1);

  // 已成功的 a…e 各只有一条 Release，没有被重投。
  const counts = releaseCounts(state);
  for (const suffix of ["a", "b", "c", "d", "e"]) {
    assert.equal(counts.get(pkgName(suffix)), 1, `${suffix} 被重投了`);
  }
  assert.equal(counts.get(pkgName("f")), 1);

  const fRelease = latestReleaseOf(state, pkgName("f"));
  assert.equal(fRelease?.Commit, SHA_F);
  assert.equal(fRelease?.Tag, "1.0.6");

  // 旧包的当前轮仍是第 1 轮；f 也是第 1 轮。
  const snapshots = await currentSnapshots(releaseId);
  assert.deepEqual(
    snapshots.map((item) => [item.packageName, item.attempt]).sort(),
    [
      [pkgName("a"), 1],
      [pkgName("b"), 1],
      [pkgName("c"), 1],
      [pkgName("d"), 1],
      [pkgName("e"), 1],
      [pkgName("f"), 1],
    ],
  );

  // 投递请求日志：现读工作流 + 投递 f 都留了记录。
  const logs = await prisma.crpCallLog.findMany({
    where: { releaseId },
    select: { method: true, url: true, statusCode: true },
  });
  assert.equal(
    logs.some((row) => row.url.endsWith("/workflow/info") && row.statusCode === 200),
    true,
  );
  assert.equal(
    logs.some((row) => row.url.endsWith("/new_release") && row.statusCode === 201),
    true,
  );

  // AC6：留痕里有谁、加了什么、放弃了什么、重投了什么。
  const history = await prisma.releaseUpdateRecord.findMany({ where: { releaseId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].action, "append");
  assert.deepEqual(history[0].packageNames, [pkgName("f")]);
  assert.deepEqual(history[0].abandonedCrpReleaseIds, []);
  assert.deepEqual(history[0].redispatchedPackageNames, [pkgName("f")]);
  assert.equal(history[0].operatorId, fixture.userId);
  assert.equal(history[0].revisionBefore, 1);
  assert.equal(history[0].revisionAfter, 2);

  // 页面按同一份数据列出留痕。
  const view = await loadReleaseUpdateView(releaseId, { network: networkOf(state) });
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].operatorName, `${PREFIX} 开发者`);
  assert.equal(view.lockReason, null);
});

// ---------------------------------------------------------------------------
// AC2：换上游 → 全部传递下游放弃并重投，非下游不动
// ---------------------------------------------------------------------------

test("AC2 换上游的 Commit：菱形的全部传递下游被放弃并重投，非下游的包不受影响", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac2");
  await dispatchToSuccess(state, releaseId);

  const before = new Map(
    (await currentSnapshots(releaseId)).map((item) => [item.packageName, item]),
  );
  // 更新会把 a…d 的旧 Release 从 CRP 侧删掉，所以先记下它们的 ID 再动手。
  const oldReleaseIds = new Map(
    ["a", "b", "c", "d"].map((suffix) => [pkgName(suffix), latestReleaseOf(state, pkgName(suffix))?.ID]),
  );

  const result = await applyReleaseUpdate(
    releaseId,
    {
      append: [],
      replace: [
        { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
      ],
    },
    updateOptions(state),
  );

  // 传递下游要算到多层：b、c 依赖 a，d 依赖 b 与 c（菱形），d 只出现一次；e 不受影响。
  assert.deepEqual(result.plan.replacedPackageNames, [pkgName("a")]);
  assert.deepEqual(result.plan.redispatchedPackageNames, ["a", "b", "c", "d"].map(pkgName).sort());

  // 放弃的是 a、b、c、d 四条已投递的 Release，e 那条不放弃。
  assert.deepEqual(
    [...result.abandonedCrpReleaseIds].sort(),
    ["a", "b", "c", "d"].map((suffix) => String(oldReleaseIds.get(pkgName(suffix)))).sort(),
  );
  assert.equal(result.abandonedCrpReleaseIds.includes(String(oldReleaseIds.get(pkgName("e")))), false);

  // 旧轮留着并标 superseded，指向新轮；参数没变的下游也新起一轮。
  const allRows = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: {
      id: true,
      packageName: true,
      attempt: true,
      status: true,
      supersededById: true,
      releaseVersion: true,
      codeVersion: true,
      commitSha: true,
    },
  });
  const old = allRows.filter((row) => row.supersededById !== null);

  assert.deepEqual(
    old.map((row) => row.packageName).sort(),
    ["a", "b", "c", "d"].map(pkgName).sort(),
  );
  assert.equal(old.every((row) => row.status === "superseded"), true);

  const current = new Map(
    allRows
      .filter((row) => row.supersededById === null)
      .map((row) => [row.packageName, row]),
  );

  // MUST：Tag 不变，只换 Commit 与代码版本。
  const a = current.get(pkgName("a"));
  assert.equal(a?.commitSha, SHA_A2);
  assert.equal(a?.codeVersion, "1.0.9");
  assert.equal(a?.releaseVersion, "1.0.1");
  assert.equal(a?.attempt, 2);

  // 下游的参数原样保留，只是重新起一轮。
  const b = current.get(pkgName("b"));
  assert.equal(b?.attempt, 2);
  assert.equal(b?.commitSha, SHA_B);
  assert.equal(b?.releaseVersion, "1.0.2");

  // 非下游的 e：仍是第 1 轮、同一条 Release，没被放弃也没被重投。
  const e = current.get(pkgName("e"));
  assert.equal(e?.attempt, 1);
  assert.equal(e?.id, before.get(pkgName("e"))?.id ?? e?.id);
  assert.equal(releaseCounts(state).get(pkgName("e")), 1);
  assert.equal(latestReleaseOf(state, pkgName("e"))?.Commit, SHA_E);

  // 这次更新先重投 a（被换的包），a…d 的旧 Release 已经从 CRP 侧删掉。
  assert.equal(result.advance?.packageName, pkgName("a"));
  const counts = releaseCounts(state);
  for (const suffix of ["b", "c", "d"]) {
    assert.equal(counts.get(pkgName(suffix)), undefined, `${suffix} 的旧 Release 没被放弃`);
  }

  // 新投的 a：Commit 换了、Tag 没换。
  const aRelease = latestReleaseOf(state, pkgName("a"));
  assert.equal(aRelease?.Commit, SHA_A2);
  assert.equal(aRelease?.Tag, "1.0.1");

  // 整条链会按拓扑顺序重投：把 a 标成功，下一轮推进投 b（或 c），不会跳。
  setBuild(state, pkgName("a"), "BUILD_OK", "BUILD_OK");
  const next = await advanceRelease(releaseId, { network: networkOf(state) });
  assert.equal(next.action, "dispatched");
  assert.equal(next.packageName, pkgName("b"));

  // 留痕：换包一行，记下放弃了什么、重投了什么。
  const history = await prisma.releaseUpdateRecord.findMany({ where: { releaseId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].action, "replace");
  assert.deepEqual(history[0].packageNames, [pkgName("a")]);
  assert.equal(history[0].abandonedCrpReleaseIds.length, 4);
  assert.deepEqual(history[0].redispatchedPackageNames, ["a", "b", "c", "d"].map(pkgName).sort());
});

// ---------------------------------------------------------------------------
// AC3：已转测拒绝更新；读不到进度同样拒绝
// ---------------------------------------------------------------------------

test("AC3 提测转测后更新被拒绝并说明原因，提测保持原样", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac3");
  await dispatchToSuccess(state, releaseId);

  const beforeSnapshotCount = await prisma.releasePackageSnapshot.count({ where: { releaseId } });
  const deletedBefore = state.received.filter((item) => item.startsWith("DELETE")).length;

  // 把 Topic 推进到 WorkProgress = 20（转测试中）。
  state.workProgress = 20;

  await assert.rejects(
    () =>
      applyReleaseUpdate(
        releaseId,
        {
          append: [],
          replace: [
            { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
          ],
        },
        updateOptions(state),
      ),
    (error: unknown) => {
      assert.equal(error instanceof ReleaseError, true);
      const failure = error as ReleaseError;

      assert.equal(failure.status, 409);
      assert.match(failure.message, /转测/);
      assert.match(failure.message, /20/);

      return true;
    },
  );

  // 提测保持原样：轮次、快照、留痕都没动，也没有向 CRP 发过删除。
  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { revision: true, status: true },
  });
  assert.equal(release.revision, 1);
  assert.equal(release.status, "success");
  assert.equal(await prisma.releasePackageSnapshot.count({ where: { releaseId } }), beforeSnapshotCount);
  assert.equal(await prisma.releaseUpdateRecord.count({ where: { releaseId } }), 0);
  assert.equal(
    state.received.filter((item) => item.startsWith("DELETE")).length,
    deletedBefore,
  );

  // 预览也要拒绝：页面不能显示一份做不了的清单。
  await assert.rejects(
    () =>
      previewReleaseUpdate(
        releaseId,
        {
          append: [],
          replace: [
            { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
          ],
        },
        { reader, network: networkOf(state) },
      ),
    (error: unknown) => (error as ReleaseError).status === 409,
  );
});

test("AC3 读不到 CRP 工作流进度时拒绝更新，不默认放行", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac3b");
  await dispatchToSuccess(state, releaseId);

  state.workflowFails = true;

  await assert.rejects(
    () =>
      applyReleaseUpdate(
        releaseId,
        {
          append: [],
          replace: [
            { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
          ],
        },
        updateOptions(state),
      ),
    (error: unknown) => {
      const failure = error as ReleaseError;

      assert.equal(failure.status, 502);
      assert.match(failure.message, /读不到 CRP 的工作流进度/);

      return true;
    },
  );

  // 页面把「读不到」的原因摆出来，并明确说更新会被拒绝。
  const view = await loadReleaseUpdateView(releaseId, { network: networkOf(state) });
  assert.equal(view.workProgress, null);
  assert.match(view.lockReason ?? "", /读不到/);
});

// ---------------------------------------------------------------------------
// AC4：连发两次更新不产生重复 Release
// ---------------------------------------------------------------------------

test("AC4 对同一提测连发两次更新，CRP 侧不会出现重复 Release", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac4");
  await dispatchToSuccess(state, releaseId);

  const update = () =>
    applyReleaseUpdate(
      releaseId,
      {
        append: [],
        replace: [
          { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
        ],
      },
      updateOptions(state),
    );

  const results = await Promise.allSettled([update(), update()]);
  const fulfilled = results.filter(
    (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof update>>> =>
      item.status === "fulfilled",
  );
  const rejected = results.filter((item) => item.status === "rejected");

  // 第二个请求要么排队后正常结束，要么收到明确的 409 —— 不允许两条更新同时改一条提测。
  assert.equal(fulfilled.length + rejected.length, 2);
  assert.ok(fulfilled.length >= 1, "两次更新都失败了");

  for (const item of rejected) {
    const reason = (item as PromiseRejectedResult).reason as ReleaseError;
    assert.equal(reason instanceof ReleaseError, true);
    assert.equal(reason.status, 409);
  }

  // 关键断言：每个包在 CRP 侧最多一条 Release，没有重复投递。
  for (const [name, count] of releaseCounts(state)) {
    assert.equal(count, 1, `${name} 在 CRP 侧有 ${count} 条 Release`);
  }

  // 数据库里每个包也只有一轮是当前轮。
  const current = await currentSnapshots(releaseId);
  const byPackage = new Map<string, number>();
  for (const row of current) {
    byPackage.set(row.packageName, (byPackage.get(row.packageName) ?? 0) + 1);
  }
  assert.equal([...byPackage.values()].every((count) => count === 1), true);
});

// ---------------------------------------------------------------------------
// AC5：放弃失败 → 整次更新中止，提测保持原样
// ---------------------------------------------------------------------------

test("AC5 放弃 CRP Release 失败时整次更新中止，提测保持原样且无半成品数据", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac5");
  await dispatchToSuccess(state, releaseId);

  const beforeSnapshots = await prisma.releasePackageSnapshot.count({ where: { releaseId } });
  const beforeRelease = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { revision: true, status: true },
  });
  const firstAbandon = latestReleaseOf(state, pkgName("a"));
  const beforeReleaseCount = state.releases.length;
  assert.notEqual(firstAbandon, undefined);

  // 故障注入：第一条要放弃的 Release 删不掉。
  state.failDelete.add(firstAbandon?.ID as number);

  await assert.rejects(
    () =>
      applyReleaseUpdate(
        releaseId,
        {
          append: [],
          replace: [
            { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
          ],
        },
        updateOptions(state),
      ),
    (error: unknown) => {
      const failure = error as ReleaseError;

      assert.equal(failure.status, 502);
      assert.match(failure.message, /放弃/);
      assert.match(failure.message, /中止/);

      return true;
    },
  );

  // 提测原样：轮次与状态没变，没有新快照、没有「投递中」的残留、没有留痕。
  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { revision: true, status: true },
  });
  assert.equal(release.revision, beforeRelease.revision);
  assert.equal(release.status, beforeRelease.status);
  assert.equal(await prisma.releasePackageSnapshot.count({ where: { releaseId } }), beforeSnapshots);
  assert.equal(await prisma.releaseUpdateRecord.count({ where: { releaseId } }), 0);
  assert.equal(
    (await currentSnapshots(releaseId)).every((row) => row.status === "success"),
    true,
  );

  // CRP 侧也没有新投递、没有多删：Release 数量与失败前一致。
  assert.equal(state.releases.length, beforeReleaseCount);
});

test("AC5 放弃到一半失败：已删掉的包被退回待投递，定时器能把缺的包补回来", async () => {
  const state = newFakeCrp();
  const releaseId = await createChainRelease("ac5b");
  await dispatchToSuccess(state, releaseId);

  const beforeRelease = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { revision: true },
  });
  const beforeSnapshotCount = await prisma.releasePackageSnapshot.count({ where: { releaseId } });
  const aRelease = latestReleaseOf(state, pkgName("a"));
  const bRelease = latestReleaseOf(state, pkgName("b"));

  assert.notEqual(aRelease, undefined);
  assert.notEqual(bRelease, undefined);

  // 第一条（a）删得掉、第二条（b）删不掉：这正是「删了一半」的场景。
  state.failDelete.add(bRelease?.ID as number);

  await assert.rejects(
    () =>
      applyReleaseUpdate(
        releaseId,
        {
          append: [],
          replace: [
            { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
          ],
        },
        updateOptions(state),
      ),
    (error: unknown) => (error as ReleaseError).status === 502,
  );

  // 数据库那一半整体回滚：轮次没变、没有新快照、没有留痕。
  const release = await prisma.release.findUniqueOrThrow({
    where: { id: releaseId },
    select: { revision: true, status: true },
  });
  assert.equal(release.revision, beforeRelease.revision);
  assert.equal(
    await prisma.releasePackageSnapshot.count({ where: { releaseId } }),
    beforeSnapshotCount,
  );
  assert.equal(await prisma.releaseUpdateRecord.count({ where: { releaseId } }), 0);

  // CRP 侧 a 的旧 Release 已经删掉，本地不能还写着「成功」：补偿把它退回待投递。
  assert.equal(
    state.releases.some((item) => item.ID === aRelease?.ID),
    false,
  );
  const compensated = (await currentSnapshots(releaseId)).find(
    (item) => item.packageName === pkgName("a"),
  );
  assert.equal(compensated?.status, "pending");
  // 提测回到「投递中」，否则终局状态会被 advanceRelease 跳过，退回的包没人投。
  assert.equal(release.status, "dispatching");

  // 定时器按原参数重投，缺的那个包补回来，产物与作废前一致。
  state.failDelete.clear();
  const next = await advanceRelease(releaseId, { network: networkOf(state) });
  assert.equal(next.action, "dispatched");
  assert.equal(next.packageName, pkgName("a"));

  const restored = latestReleaseOf(state, pkgName("a"));
  assert.equal(restored?.Commit, SHA_A);
  assert.equal(restored?.Tag, "1.0.1");
  assert.equal(state.releases.length, 5);
});

// ---------------------------------------------------------------------------
// 接口接线
// ---------------------------------------------------------------------------

test("更新接口：提测不存在时返回 404，不泄露「这条提测存在过」", async () => {
  const { POST } = await import("../app/api/releases/[id]/update/route");

  const response = await POST(
    new Request("http://localhost/api/releases/not-a-release/update", {
      method: "POST",
      body: JSON.stringify({ append: [], replace: [] }),
    }),
    { params: Promise.resolve({ id: "not-a-release" }) },
  );

  assert.equal(response.status, 404);

  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "release_not_found");
});

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

test("更新输入：两组都空、同一包既补又换，都要被拒绝", () => {
  const empty = parseReleaseUpdateInput({ append: [], replace: [] });
  assert.equal(empty.ok, false);

  const both = parseReleaseUpdateInput({
    append: [{ packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null }],
    replace: [{ packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A, customTag: null }],
  });
  assert.equal(both.ok, false);

  const duplicated = parseReleaseUpdateInput({
    replace: [
      { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A, customTag: null },
      { packageName: pkgName("a"), branch: BRANCH, commitSha: SHA_A2, customTag: null },
    ],
  });
  assert.equal(duplicated.ok, false);

  const ok = parseReleaseUpdateInput({
    append: [{ packageName: pkgName("f"), branch: BRANCH, commitSha: SHA_F, customTag: null }],
  });
  assert.equal(ok.ok, true);
});

test("更新留痕的动作名：三种动作都有人话，认不出的取值原样带出", () => {
  assert.equal(releaseUpdateActionLabel("append"), "补包");
  assert.equal(releaseUpdateActionLabel("replace"), "换包");
  // 详情页的更新历史与更新页的留痕表共用这一份：漏一个值就会在另一处显示成别的动作。
  assert.equal(releaseUpdateActionLabel("abandon_topic"), "放弃主题");
  assert.equal(releaseUpdateActionLabel("something_new"), "something_new");
  assert.deepEqual(Object.keys(RELEASE_UPDATE_ACTION_LABELS).sort(), [
    "abandon_topic",
    "append",
    "replace",
  ]);
});
