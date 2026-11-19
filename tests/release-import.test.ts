/**
 * 从 CRP 导入已有提测主题的集成测试：连真数据库，网络层换成假的 CRP，Gerrit 用假实现。
 *
 * 走的是生产代码的完整链路 —— `previewReleaseImport` / `importReleaseFromTopic` →
 * 现读主题与 Release → 逐包定 Commit、仓库路径、代码版本 → 落提测与快照 → 读一次 CRP 工作流。
 *
 * 锁住本节点的 MUST：
 *
 * - AC1：导入一个两包主题，生成两条快照，提测版本与 CRP 的 tag 逐字一致；
 * - AC2：重复导入被拒绝并指向已有记录，库里不新增；
 * - AC3：主题分支与项目基线不一致时拒绝，错误里点名两个分支；
 * - AC4：导入过程零写入 CRP（只有 GET，Release 列表不改）；
 * - AC5：拿不到 Commit 的包停在预览并点名，导入不落库；
 * - AC7：已转测的主题导入后被标记锁定，A17 的更新页给出「已经转测」。
 *
 * 另外锁住几条容易做错的：未登记软件包的仓库路径必须由 Gerrit 反查确定（唯一才认）、
 * 没见过的构建状态按待投递处理、提测版本不拿代码版本顶替。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { POST } from "../app/api/releases/import/route";
import { prisma } from "../lib/db";
import { GerritNotFoundError } from "../lib/integrations/gerrit";
import {
  importReleaseFromTopic,
  loadReleaseUpdateView,
  previewReleaseImport,
  ReleaseError,
  ReleaseImportConflict,
  type GerritReader,
} from "../lib/releases";

const PREFIX = "zza18";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
const BASELINE_NAME = `${PREFIX}-baseline`;
/** 基线在 CRP 侧的分支 ID，必须是数字。 */
const CRP_BRANCH_ID = "8861901";
const CRP_BASE = "https://crp.example.test/api";
const BRANCH = "develop/eagle";

const SHA_A = `${"a".repeat(38)}01`;
const SHA_B = `${"b".repeat(38)}02`;
const SHA_C = `${"c".repeat(38)}03`;
const SHA_D = `${"d".repeat(38)}04`;

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

/**
 * 仓库路径：最后一段与包名相同。
 *
 * 这不是巧合，而是真实情况：CRP 的 `ProjectName` 就是包名，Gerrit 的仓库路径最后一段
 * 通常也等于包名。未登记软件包能自动登记，靠的就是「按最后一段找到唯一候选」再验提交。
 */
function repoOf(suffix: string): string {
  return `${PREFIX}/${pkgName(suffix)}`;
}

/** 代码版本必须是 CRP Tag 能接受的形式：数字开头、不含 `-` `_` 空格。 */
const CODE_VERSIONS: Record<string, string> = {
  [SHA_A]: "1.0.1",
  [SHA_B]: "1.0.2",
  [SHA_C]: "1.0.3",
  [SHA_D]: "1.0.4",
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
  BuildState: { state?: string } | null;
};

type FakeTopic = {
  ID: number;
  Name: string;
  BranchID: number;
  Type: string;
  Abandoned: boolean;
  Completed: boolean;
  State: number;
  Owner: { name: string; namecn: string }[] | null;
};

type FakeCrp = {
  topics: Map<number, FakeTopic>;
  releases: FakeRelease[];
  /** 每次请求的方法与路径，用来证明「只读」与「没重投」。 */
  calls: string[];
  workProgress: number;
  workflowFails: boolean;
};

let nextTopicId = 31_000;
let nextReleaseId = 81_000;

function newFakeCrp(): FakeCrp {
  return {
    topics: new Map(),
    releases: [],
    calls: [],
    workProgress: 0,
    workflowFails: false,
  };
}

type TopicSeed = {
  name?: string;
  type?: string;
  branchId?: number;
  abandoned?: boolean;
  completed?: boolean;
  releases: Array<{
    projectName: string;
    tag: string;
    commit: string;
    branch?: string;
    buildState?: string | null;
  }>;
};

/** 在假 CRP 里放一个主题；返回它的 ID。 */
function addTopic(state: FakeCrp, seed: TopicSeed): number {
  const topicId = nextTopicId++;
  const branchId = seed.branchId ?? Number(CRP_BRANCH_ID);

  state.topics.set(topicId, {
    ID: topicId,
    Name: seed.name ?? `${PREFIX} 主题 ${topicId}`,
    BranchID: branchId,
    Type: seed.type ?? "test",
    Abandoned: seed.abandoned ?? false,
    Completed: seed.completed ?? false,
    State: 0,
    Owner: [{ name: "crp-user", namecn: "CRP 用户" }],
  });

  for (const release of seed.releases) {
    state.releases.push({
      ID: nextReleaseId++,
      TopicID: topicId,
      ProjectID: 800,
      ProjectName: release.projectName,
      Branch: release.branch ?? BRANCH,
      Commit: release.commit,
      Tag: release.tag,
      BuildID: 900_000 + nextReleaseId,
      BuildState: release.buildState === null ? null : { state: release.buildState ?? "UPLOAD_OK" },
    });
  }

  return topicId;
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  return new URL(url).pathname.replace(/^\/api/, "");
}

/** 假的 CRP 网络层：行为按 FINDINGS.md 里实测的响应形态写。 */
function crpFetchOf(state: FakeCrp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${path}`);

    const topicReleases = /^\/topics\/(\d+)\/releases$/.exec(path);

    if (method === "GET" && topicReleases !== null) {
      const topicId = Number(topicReleases[1]);

      return json(JSON.stringify(state.releases.filter((item) => item.TopicID === topicId)));
    }

    const workflow = /^\/topics\/(\d+)\/workflow\/info$/.exec(path);

    if (method === "GET" && workflow !== null) {
      if (state.workflowFails) {
        return json(JSON.stringify({ message: "workflow unavailable" }), 500);
      }

      return json(
        JSON.stringify({
          TopicID: Number(workflow[1]),
          TopicName: state.topics.get(Number(workflow[1]))?.Name ?? "",
          WorkProgress: state.workProgress,
        }),
      );
    }

    const topic = /^\/topics\/(\d+)$/.exec(path);

    if (method === "GET" && topic !== null) {
      const found = state.topics.get(Number(topic[1]));

      if (found === undefined) {
        return json(JSON.stringify({ message: "Not Found" }), 404);
      }

      return json(JSON.stringify(found));
    }

    // 任何写操作、以及 POST /topics/search 都没有实现：真发了就会在测试里露出来。
    return json(JSON.stringify({ message: `测试没有实现 ${method} ${path}` }), 404);
  }) as typeof fetch;
}

function networkOf(state: FakeCrp) {
  return { crpBaseUrl: CRP_BASE, crpToken: "test-token", crpFetch: crpFetchOf(state) };
}

// ---------------------------------------------------------------------------
// 假的 Gerrit
// ---------------------------------------------------------------------------

type FakeGerrit = {
  /** `GET /a/projects/` 会返回的全部仓库路径。 */
  projects: string[];
  /** `${repoPath}@${commitSha}` → 代码版本；查不到视为该仓库没有这个提交。 */
  versions: Map<string, string>;
  /** `${repoPath}@${tag}` → 提交号；查不到视为该仓库没有这个 Tag。 */
  tags: Map<string, string>;
  calls: string[];
};

function newFakeGerrit(): FakeGerrit {
  return { projects: [], versions: new Map(), tags: new Map(), calls: [] };
}

/** 记事：已登记软件包 a、b 的仓库里都有各自的提交。 */
function gerritWithRegistered(state: FakeGerrit): GerritReader {
  for (const [suffix, sha] of [
    ["a", SHA_A],
    ["b", SHA_B],
  ]) {
    state.versions.set(`${repoOf(suffix)}@${sha}`, CODE_VERSIONS[sha]);
  }

  return gerritOf(state);
}

function gerritOf(state: FakeGerrit): GerritReader {
  return {
    async listBranches(repoPath) {
      state.calls.push(`branches ${repoPath}`);
      return [BRANCH];
    },

    async listCommits(repoPath) {
      state.calls.push(`commits ${repoPath}`);
      return [];
    },

    async readCodeVersion(repoPath, commitSha) {
      state.calls.push(`version ${repoPath}@${commitSha}`);
      const version = state.versions.get(`${repoPath}@${commitSha}`);

      if (version === undefined) {
        throw new GerritNotFoundError(`项目 ${repoPath} 上找不到提交 ${commitSha}。`);
      }

      return version;
    },

    async listProjects() {
      state.calls.push("projects");

      return state.projects;
    },

    async resolveTagCommit(repoPath, tag) {
      state.calls.push(`tag ${repoPath}@${tag}`);

      return state.tags.get(`${repoPath}@${tag}`) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
  projectId: string;
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

  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
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

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });
  await prisma.baselinePackageVersion.deleteMany({ where: { baselineId: { in: baselineIds } } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });

  await prisma.membership.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  await prisma.packageDependency.deleteMany({
    where: {
      OR: [
        { package: { name: { startsWith: PREFIX } } },
        { upstreamPackage: { name: { startsWith: PREFIX } } },
      ],
    },
  });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
      displayName: `${PREFIX} 发起人`,
      passwordHash: "not-a-real-hash",
    },
    select: { id: true },
  });

  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: CRP_BRANCH_ID,
      name: BASELINE_NAME,
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  // 基线里已经有一个 a 的仓库版本：预览里应当带出来。
  await prisma.baselinePackageVersion.create({
    data: {
      baselineId: baseline.id,
      packageName: pkgName("a"),
      version: "1.0.0-1",
      fetchedAt: new Date("2026-11-18T00:00:00Z"),
    },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  // 只登记 a、b 两个软件包；c…e 故意不登记，用来验「未登记软件包」的三条分支。
  const packageIds = new Map<string, string>();

  for (const suffix of ["a", "b"]) {
    const created = await prisma.package.create({
      data: { name: pkgName(suffix), repoPath: repoOf(suffix), defaultBranch: BRANCH },
      select: { id: true },
    });

    packageIds.set(suffix, created.id);
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

  // 项目清单里是 a、b：导入只回写这两行的「上次提测的提交」。
  for (const suffix of ["a", "b"]) {
    await prisma.projectSoftware.create({
      data: {
        projectId: project.id,
        packageId: packageIds.get(suffix) as string,
        trackedBranch: BRANCH,
      },
    });
  }

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    projectId: project.id,
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("导入两包主题：两条快照，提测版本与 CRP 的 tag 逐字一致，CRP 侧零写入", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  const topicId = addTopic(state, {
    releases: [
      { projectName: pkgName("a"), tag: "1.0.0.9-deepin1", commit: SHA_A, buildState: "UPLOAD_OK" },
      { projectName: pkgName("b"), tag: "2.3.4", commit: SHA_B, buildState: "UPLOAD_CRP" },
    ],
  });

  const before = await prisma.release.count({ where: { projectId: fixture.projectId } });
  const releaseCountBefore = state.releases.length;

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  // 一个包已成功、一个还在上传：整条提测是 building，不是 success。
  assert.equal(result.status, "building");
  assert.equal(result.revision, 1);
  assert.equal(result.version, "1.0.0.9-deepin1");
  assert.equal(result.packages.length, 2);
  // SHOULD：提测版本与代码版本不同时标出来，因为它往往正是要改包的原因。
  assert.equal(result.packages[0].versionMismatch, true);
  assert.equal(result.packages[0].repoVersion, "1.0.0-1");
  assert.deepEqual(result.autoRegisteredPackages, []);
  assert.deepEqual(result.addedToProject, []);

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: result.releaseId },
    include: {
      snapshots: { orderBy: { packageName: "asc" } },
      repositoryRecords: { orderBy: { crpReleaseId: "asc" } },
    },
  });

  assert.equal(release.source, "imported");
  assert.equal(release.crpTopicId, String(topicId));
  assert.equal(release.crpBranchId, CRP_BRANCH_ID);
  assert.equal(release.revision, 1);
  assert.equal(release.snapshots.length, 2);

  const [snapshotA, snapshotB] = release.snapshots;

  assert.equal(snapshotA.packageName, pkgName("a"));
  assert.equal(snapshotA.attempt, 1);
  assert.equal(snapshotA.branch, BRANCH);
  assert.equal(snapshotA.commitSha, SHA_A);
  // MUST：提测版本逐字取自 CRP 的 tag，与代码版本不同也照样用 tag。
  assert.equal(snapshotA.releaseVersion, "1.0.0.9-deepin1");
  assert.notEqual(snapshotA.releaseVersion, snapshotA.codeVersion);
  assert.equal(snapshotA.codeVersion, CODE_VERSIONS[SHA_A]);
  assert.equal(snapshotA.repoVersion, "1.0.0-1");
  assert.equal(snapshotA.status, "success");

  assert.equal(snapshotB.packageName, pkgName("b"));
  assert.equal(snapshotB.releaseVersion, "2.3.4");
  assert.equal(snapshotB.status, "building");
  assert.equal(snapshotB.repoVersion, null);

  // CRP 侧的 Release 具体是哪几条也记下来了：A17 改包要靠它去删旧 Release。
  assert.equal(release.repositoryRecords.length, 2);
  assert.deepEqual(
    release.repositoryRecords.map((item) => item.crpReleaseId).sort(),
    state.releases.map((item) => String(item.ID)).sort(),
  );

  // 清单里已有的包回写「上次提测的提交」。
  const softwareA = await prisma.projectSoftware.findFirstOrThrow({
    where: { projectId: fixture.projectId, package: { name: pkgName("a") } },
    select: { lastSubmittedCommit: true },
  });
  assert.equal(softwareA.lastSubmittedCommit, SHA_A);

  // AC4：对 CRP 只发过 GET，Release 列表一条没多、一条没少。
  assert.deepEqual(
    state.calls.filter((call) => !call.startsWith("GET ")),
    [],
    "导入不许向 CRP 写任何东西",
  );
  assert.equal(state.releases.length, releaseCountBefore);
  assert.equal(
    await prisma.release.count({ where: { projectId: fixture.projectId } }),
    before + 1,
  );
});

test("重复导入同一主题：拒绝并指向已有记录，库里不新增", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  const topicId = addTopic(state, {
    releases: [
      { projectName: pkgName("a"), tag: "3.1.0", commit: SHA_A },
      { projectName: pkgName("b"), tag: "3.1.0", commit: SHA_B },
    ],
  });

  const first = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  const before = await prisma.release.count({ where: { projectId: fixture.projectId } });

  const second = importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  await assert.rejects(second, (error: unknown) => {
    assert.ok(error instanceof ReleaseImportConflict, "应当是「已导入」冲突，而不是普通报错");
    assert.equal(error.existingReleaseId, first.releaseId);
    assert.equal(error.existingVersion, first.version);
    assert.match(error.message, /只能导入一次/);

    return true;
  });

  assert.equal(await prisma.release.count({ where: { projectId: fixture.projectId } }), before);

  // 预览同样提示已导入，页面因此能直接跳到已有记录。
  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.existing?.releaseId, first.releaseId);
});

test("主题分支与项目基线不一致：拒绝导入，错误里点名两个分支", async () => {
  const state = newFakeCrp();
  const topicId = addTopic(state, {
    branchId: 999_999,
    releases: [{ projectName: pkgName("a"), tag: "4.0.0", commit: SHA_A }],
  });

  await assert.rejects(
    importReleaseFromTopic({
      projectId: fixture.projectId,
      topicId,
      createdById: fixture.userId,
      reader: gerritWithRegistered(newFakeGerrit()),
      network: networkOf(state),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /999999/);
      assert.match(error.message, new RegExp(BASELINE_NAME));

      return true;
    },
  );

  assert.equal(await prisma.release.count({ where: { crpTopicId: String(topicId) } }), 0);
});

test("拿不到 Commit 的包：停在预览并点名，导入不落库", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  // CRP 对预置 deb 会填 uploadcrp 这种占位值，它不是提交号；Gerrit 上也没有同名 Tag。
  const topicId = addTopic(state, {
    releases: [
      { projectName: pkgName("a"), tag: "5.0.0+uploadcrp", commit: "uploadcrp" },
      { projectName: pkgName("b"), tag: "5.0.0", commit: SHA_B },
    ],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.packages.length, 1, "只有定得下来的包进映射");
  assert.equal(preview.blocked.length, 1);
  assert.equal(preview.blocked[0].packageName, pkgName("a"));
  assert.match(preview.blocked[0].reason, /拿不到 Commit/);
  assert.match(preview.blocked[0].reason, /uploadcrp/);

  await assert.rejects(
    importReleaseFromTopic({
      projectId: fixture.projectId,
      topicId,
      createdById: fixture.userId,
      reader: gerritWithRegistered(gerrit),
      network: networkOf(state),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, new RegExp(pkgName("a")));

      return true;
    },
  );

  assert.equal(await prisma.release.count({ where: { crpTopicId: String(topicId) } }), 0);
  assert.equal(
    await prisma.releasePackageSnapshot.count({ where: { release: { crpTopicId: String(topicId) } } }),
    0,
  );
});

test("CRP 没给提交号时按 Tag 去 Gerrit 反查，快照记下反查到的提交", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  gerrit.tags.set(`${repoOf("a")}@6.0.0`, SHA_A);
  gerrit.versions.set(`${repoOf("a")}@${SHA_A}`, CODE_VERSIONS[SHA_A]);

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("a"), tag: "6.0.0", commit: "" }],
  });

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.equal(result.packages[0].commitSource, "gerrit-tag");
  assert.equal(result.packages[0].commitSha, SHA_A);

  const snapshot = await prisma.releasePackageSnapshot.findFirstOrThrow({
    where: { releaseId: result.releaseId },
    select: { commitSha: true, releaseVersion: true },
  });

  assert.equal(snapshot.commitSha, SHA_A);
  assert.equal(snapshot.releaseVersion, "6.0.0");
});

test("未登记的软件包：仓库路径在 Gerrit 上唯一时自动登记，默认不进项目清单", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  gerrit.projects = [repoOf("c"), repoOf("a"), "other/repo"];
  gerrit.versions.set(`${repoOf("c")}@${SHA_C}`, CODE_VERSIONS[SHA_C]);

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("c"), tag: "7.0.0", commit: SHA_C }],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.packages[0].packageId, null, "预览里标出「将自动登记」");
  assert.equal(preview.packages[0].repoPath, repoOf("c"));

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.deepEqual(result.autoRegisteredPackages, [pkgName("c")]);

  const created = await prisma.package.findUniqueOrThrow({
    where: { name: pkgName("c") },
    select: { repoPath: true, defaultBranch: true },
  });
  assert.equal(created.repoPath, repoOf("c"));
  assert.equal(created.defaultBranch, BRANCH);

  // MUST：不勾「一并加入清单」时，项目软件清单保持原样。
  assert.equal(
    await prisma.projectSoftware.count({
      where: { projectId: fixture.projectId, package: { name: pkgName("c") } },
    }),
    0,
  );
});

test("未登记的软件包：勾了「一并加入清单」才加进项目软件清单", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  gerrit.projects = [repoOf("d")];
  gerrit.versions.set(`${repoOf("d")}@${SHA_D}`, CODE_VERSIONS[SHA_D]);

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("d"), tag: "8.0.0", commit: SHA_D }],
  });

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    addPackagesToProject: true,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.deepEqual(result.autoRegisteredPackages, [pkgName("d")]);
  assert.deepEqual(result.addedToProject, [pkgName("d")]);

  const software = await prisma.projectSoftware.findFirstOrThrow({
    where: { projectId: fixture.projectId, package: { name: pkgName("d") } },
    select: { trackedBranch: true, lastSubmittedCommit: true },
  });

  assert.equal(software.trackedBranch, BRANCH);
  assert.equal(software.lastSubmittedCommit, SHA_D);
});

test("未登记的软件包：候选有多个，但只有一个仓库真有这个提交时照常导入", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  // 真实情况：`startdde` 在 Gerrit 上有 startdde、smartos/app/startdde、snipe/startdde 三个仓库，
  // 但 CRP 记的那个提交只在其中一个里。提交能证明是哪一个，就不算猜。
  gerrit.projects = [repoOf("f"), `smartos/app/${repoOf("f")}`, `snipe/${repoOf("f")}`];
  gerrit.versions.set(`${repoOf("f")}@${SHA_D}`, CODE_VERSIONS[SHA_D]);

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("f"), tag: "14.0.0", commit: SHA_D }],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.packages[0].repoPath, repoOf("f"));
  assert.equal(preview.packages[0].codeVersion, CODE_VERSIONS[SHA_D]);

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.deepEqual(result.autoRegisteredPackages, [pkgName("f")]);

  const created = await prisma.package.findUniqueOrThrow({
    where: { name: pkgName("f") },
    select: { repoPath: true },
  });
  assert.equal(created.repoPath, repoOf("f"));
});

test("未登记的软件包：候选仓库不唯一时停在预览，不猜一个用", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  // 两个仓库的最后一段都是这个包名，而且都确实有这个提交：不许挑一个用。
  gerrit.projects = [repoOf("e"), `vendor/${repoOf("e")}`];
  gerrit.versions.set(`${repoOf("e")}@${SHA_C}`, CODE_VERSIONS[SHA_C]);
  gerrit.versions.set(`vendor/${repoOf("e")}@${SHA_C}`, CODE_VERSIONS[SHA_C]);

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("e"), tag: "9.0.0", commit: SHA_C }],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritOf(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.blocked[0].packageName, pkgName("e"));
  assert.match(preview.blocked[0].reason, /仓库路径不确定/);

  assert.equal(await prisma.package.count({ where: { name: pkgName("e") } }), 0);
});

test("已转测的主题：导入后标记锁定，A17 的更新页给出「已经转测」", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();
  state.workProgress = 20;

  const topicId = addTopic(state, {
    releases: [{ projectName: pkgName("a"), tag: "10.0.0", commit: SHA_A, buildState: "UPLOAD_OK" }],
  });

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  assert.equal(result.locked, true);
  assert.equal(result.workProgress, 20);
  assert.equal(result.workProgressLabel, "转测试中（无法更新包）");
  // 一个包，且 CRP 侧已成功：整条提测是 success，不需要再推进。
  assert.equal(result.status, "success");

  const stored = await prisma.release.findUniqueOrThrow({
    where: { id: result.releaseId },
    select: { crpWorkProgress: true, crpWorkProgressLabel: true, crpWorkProgressSyncedAt: true },
  });

  assert.equal(stored.crpWorkProgress, 20);
  assert.equal(stored.crpWorkProgressLabel, "转测试中（无法更新包）");
  assert.notEqual(stored.crpWorkProgressSyncedAt, null, "导入后立刻落一次进度");

  // AC7：A17 的更新入口对这条记录不可用。
  const view = await loadReleaseUpdateView(result.releaseId, { network: networkOf(state) });
  assert.match(view.lockReason ?? "", /已经转测/);
});

test("没见过的构建状态按待投递处理，并在预览里标出来", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();

  const topicId = addTopic(state, {
    releases: [
      { projectName: pkgName("a"), tag: "11.0.0", commit: SHA_A, buildState: "SOMETHING_NEW" },
    ],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.packages[0].buildState, "SOMETHING_NEW");
  assert.equal(preview.packages[0].buildStateKnown, false);
  assert.equal(preview.packages[0].status, "pending");
  assert.match(preview.packages[0].buildStateNote ?? "", /没见过的构建状态/);

  const result = await importReleaseFromTopic({
    projectId: fixture.projectId,
    topicId,
    createdById: fixture.userId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  // 绝不因为「状态看不懂」就记成成功。
  assert.equal(result.status, "pending");
});

test("非 test 类型的主题不导入", async () => {
  const state = newFakeCrp();
  const topicId = addTopic(state, {
    type: "dev",
    releases: [{ projectName: pkgName("a"), tag: "12.0.0", commit: SHA_A }],
  });

  await assert.rejects(
    previewReleaseImport({
      projectId: fixture.projectId,
      topicId,
      reader: gerritWithRegistered(newFakeGerrit()),
      network: networkOf(state),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 400);
      assert.match(error.message, /只支持导入 test 类型/);

      return true;
    },
  );
});

test("主题里同一个包有多条 Release：停在预览，不在一条提测里塞两轮", async () => {
  const state = newFakeCrp();
  const gerrit = newFakeGerrit();

  const topicId = addTopic(state, {
    releases: [
      { projectName: pkgName("a"), tag: "13.0.0", commit: SHA_A, branch: "develop/eagle" },
      { projectName: pkgName("a"), tag: "13.0.0", commit: SHA_A, branch: "develop/master" },
    ],
  });

  const preview = await previewReleaseImport({
    projectId: fixture.projectId,
    topicId,
    reader: gerritWithRegistered(gerrit),
    network: networkOf(state),
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.blocked.length, 1);
  assert.match(preview.blocked[0].reason, /多条 Release/);
});

// ---------------------------------------------------------------------------
// 接口层：请求体校验与鉴权
// ---------------------------------------------------------------------------

function importRequest(body: unknown): Request {
  return new Request("http://localhost/api/releases/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("接口：请求体不是 JSON 时返回 400", async () => {
  const response = await POST(importRequest("not json"));

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_json");
});

test("接口：mode 必填，避免「本想预览却真导入了」", async () => {
  const response = await POST(importRequest({ projectId: fixture.projectId, topicId: 1 }));

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "invalid_payload");
  assert.match(body.error.message, /mode/);
});

test("接口：topicId 不是正整数时返回 400", async () => {
  const response = await POST(
    importRequest({ projectId: fixture.projectId, topicId: 0, mode: "preview" }),
  );

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_payload");
});

test("接口：项目不存在时返回 404，不进入权限判定", async () => {
  const response = await POST(
    importRequest({
      projectId: "00000000-0000-7000-8000-000000000000",
      topicId: 1,
      mode: "preview",
    }),
  );

  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "project_not_found",
  );
});

// GET 的第一件事是鉴权（`requireRole` 要读会话 Cookie），在测试进程里没有请求作用域，
// 所以这一处只由端到端验收覆盖；上面四条覆盖的是鉴权之前的请求体校验。
