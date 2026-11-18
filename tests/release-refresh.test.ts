/**
 * 第二步「检查仓库更新」的集成测试：真连数据库，Gerrit 用假客户端替换。
 *
 * 锁住的是：
 *
 * - 每个包给的是项目清单里的跟踪分支，以及该分支的最新提交；
 * - 跟踪分支在仓库里不存在时退回第一个分支，并把这件事作为「提示」报出来（不挡提交）；
 * - 一个包读失败只标在它自己身上，其余包照常返回；
 * - 切分支会重新读提交与代码版本，不沿用上一个分支的版本；
 * - 仓库版本取自基线缓存，读不到基线就发不出请求。
 *
 * 用的库、项目、软件包都带固定前缀，跑完自己清掉，不影响种子数据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { GerritNotFoundError, type GerritClient } from "../lib/integrations/gerrit";
import { createGerritReader, type GerritReader } from "../lib/releases";
import { loadBranchCommits, readCommitCodeVersion, refreshProjectPackages } from "../lib/releases/refresh";
import { loadReleaseProject } from "../lib/releases/service";
import { prisma } from "../lib/db";

const PREFIX = "zz886";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;

type Fixture = {
  workspaceId: string;
  baselineId: string;
  projectId: string;
  fallbackProjectId: string;
  packageIds: Record<string, string>;
};

let fixture: Fixture;

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

async function cleanup(): Promise<void> {
  const baselines = await prisma.baseline.findMany({
    where: { crpBranchId: { startsWith: PREFIX } },
    select: { id: true },
  });
  const baselineIds = baselines.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { baselineId: { in: baselineIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });
  await prisma.baselinePackageVersion.deleteMany({ where: { baselineId: { in: baselineIds } } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });
  await prisma.membership.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });

  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: `${PREFIX}-branch`,
      name: `${PREFIX}-baseline`,
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  const a = await prisma.package.create({
    data: {
      name: pkgName("a"),
      repoPath: `${PREFIX}/a`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });

  const b = await prisma.package.create({
    data: {
      name: pkgName("b"),
      repoPath: `${PREFIX}/b`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });

  // 这个包的仓库路径指向一个假客户端读不到的仓库：用来验「一个包失败不影响其它包」。
  const broken = await prisma.package.create({
    data: {
      name: pkgName("broken"),
      repoPath: `${PREFIX}/missing`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });

  // 跟踪分支在仓库里不存在：用来验「退回第一个分支 + 提示」。
  const fallback = await prisma.package.create({
    data: {
      name: pkgName("fallback"),
      repoPath: `${PREFIX}/fallback`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });

  await prisma.baselinePackageVersion.create({
    data: {
      baselineId: baseline.id,
      packageName: pkgName("a"),
      version: "1.0.0-1",
      fetchedAt: new Date("2026-11-18T00:00:00Z"),
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-main`,
      name: `${PREFIX} 主项目`,
    },
    select: { id: true },
  });

  await prisma.projectSoftware.createMany({
    data: [
      { projectId: project.id, packageId: a.id, trackedBranch: "develop/eagle" },
      { projectId: project.id, packageId: b.id, trackedBranch: "develop/master" },
      { projectId: project.id, packageId: broken.id, trackedBranch: "develop/eagle" },
    ],
  });

  const fallbackProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-fallback`,
      name: `${PREFIX} 分支不存在的项目`,
    },
    select: { id: true },
  });

  await prisma.projectSoftware.create({
    data: {
      projectId: fallbackProject.id,
      packageId: fallback.id,
      trackedBranch: "release/1.0",
    },
  });

  fixture = {
    workspaceId: workspace.id,
    baselineId: baseline.id,
    projectId: project.id,
    fallbackProjectId: fallbackProject.id,
    packageIds: { a: a.id, b: b.id, broken: broken.id, fallback: fallback.id },
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 客户端映射：分支名、提交说明首行、代码版本
// ---------------------------------------------------------------------------

function fakeClient(overrides: Partial<GerritClient> = {}): GerritClient {
  return {
    listBranches: async () => [
      { ref: "refs/heads/develop/master", branch: "develop/master", revision: "b" },
      { ref: "refs/heads/develop/eagle", branch: "develop/eagle", revision: "a" },
    ],
    listCommits: async () => [
      {
        sha: "a".repeat(40),
        parents: [],
        author: { name: "作者", email: "a@example.com", time: "t1" },
        committer: { name: "提交人", email: "c@example.com", time: "2026-11-18 10:00:00" },
        message: "fix: 修一个问题\n\n详细的正文不该出现在列表里",
      },
    ],
    getCommit: async () => {
      throw new Error("未使用");
    },
    readChangelog: async () => ({
      entry: {
        packageName: "kwin",
        version: "5.27.12.0-1",
        distribution: "unstable",
        urgency: "medium",
        date: "Tue, 18 Nov 2026 10:00:00 +0800",
      },
      text: "",
    }),
    ...overrides,
  };
}

test("分支清单按名字排序，提交只带展示要用的字段", async () => {
  const reader = createGerritReader(fakeClient());

  assert.deepEqual(await reader.listBranches("deepin-kde/kwin"), [
    "develop/eagle",
    "develop/master",
  ]);

  const commits = await reader.listCommits("deepin-kde/kwin", "develop/eagle");

  assert.deepEqual(commits, [
    {
      sha: "a".repeat(40),
      summary: "fix: 修一个问题",
      authorName: "作者",
      time: "2026-11-18 10:00:00",
    },
  ]);
});

test("读代码版本返回 changelog 首条版本", async () => {
  const reader = createGerritReader(fakeClient());

  assert.equal(await reader.readCodeVersion("deepin-kde/kwin", "a".repeat(40)), "5.27.12.0-1");
});

// ---------------------------------------------------------------------------
// 整个项目的刷新
// ---------------------------------------------------------------------------

/** 假 Gerrit：`zz886/a` 有一个分支，`zz886/b` 有另一个，`zz886/missing` 读不到。 */
function fakeReader(): GerritReader {
  return {
    async listBranches(repoPath) {
      if (repoPath === `${PREFIX}/missing`) {
        throw new GerritNotFoundError(`Gerrit 上找不到项目 ${repoPath}，无法列出分支。`);
      }

      if (repoPath === `${PREFIX}/fallback`) {
        return ["develop/eagle", "develop/master"];
      }

      return ["develop/eagle", "develop/master"];
    },

    async listCommits(repoPath, branch) {
      return [
        {
          sha: `${repoPath.endsWith("/a") ? "a" : "b"}`.repeat(40),
          summary: `${repoPath}@${branch} 的最新提交`,
          authorName: "验收",
          time: "2026-11-18 10:00:00",
        },
      ];
    },

    async readCodeVersion(repoPath, commitSha) {
      return `${repoPath.split("/").pop()}-${commitSha.slice(0, 4)}`;
    },
  };
}

test("刷新整个项目：跟踪分支的最新提交、代码版本与基线仓库版本都到位", async () => {
  const project = await loadReleaseProject(fixture.projectId);

  assert.ok(project !== null);

  const packages = await refreshProjectPackages(project, fakeReader());
  const a = packages.find((item) => item.packageName === pkgName("a"));
  const b = packages.find((item) => item.packageName === pkgName("b"));

  assert.ok(a !== undefined);
  assert.ok(b !== undefined);

  assert.equal(a.error, null);
  assert.equal(a.warning, null);
  assert.deepEqual(a.branches, ["develop/eagle", "develop/master"]);
  assert.equal(a.selected?.branch, "develop/eagle");
  assert.equal(a.selected?.commitSha, "a".repeat(40));
  assert.equal(a.selected?.codeVersion, `a-${"a".repeat(4)}`);
  // 基线缓存里只有 a 的版本。
  assert.equal(a.repoVersion, "1.0.0-1");

  // b 的跟踪分支是 develop/master：默认选中它，不选第一个分支。
  assert.equal(b.selected?.branch, "develop/master");
  assert.equal(b.repoVersion, null);
});

test("一个包读不到仓库时只标在它身上，其余包照常返回", async () => {
  const project = await loadReleaseProject(fixture.projectId);

  assert.ok(project !== null);

  const packages = await refreshProjectPackages(project, fakeReader());
  const broken = packages.find((item) => item.packageName === pkgName("broken"));

  assert.ok(broken !== undefined);
  assert.equal(broken.selected, null);
  assert.equal(broken.warning, null);
  assert.match(broken.error as string, /找不到项目/);

  // 其它包仍然有数据。
  assert.equal(packages.filter((item) => item.error === null).length, 2);
  assert.equal(packages.length, 3);
});

test("跟踪分支不存在时退回第一个分支，并给出提示（不挡提交）", async () => {
  const project = await loadReleaseProject(fixture.fallbackProjectId);

  assert.ok(project !== null);

  const packages = await refreshProjectPackages(project, fakeReader());
  const item = packages[0];

  assert.equal(item.error, null);
  assert.equal(item.selected?.branch, "develop/eagle");
  assert.match(item.warning as string, /release\/1\.0/);
  assert.match(item.warning as string, /暂用 develop\/eagle/);
});

test("切分支会重新列提交并重读代码版本", async () => {
  const { commits, selected } = await loadBranchCommits(
    `${PREFIX}/a`,
    "develop/master",
    fakeReader(),
  );

  assert.equal(commits.length, 1);
  assert.equal(selected?.branch, "develop/master");
  assert.equal(selected?.commitSha, "a".repeat(40));
  assert.equal(selected?.codeVersion, `a-${"a".repeat(4)}`);
});

test("读某个提交的代码版本可以直接传假客户端", async () => {
  const version = await readCommitCodeVersion(`${PREFIX}/a`, "1234567", fakeReader());

  assert.equal(version, "a-1234");
});
