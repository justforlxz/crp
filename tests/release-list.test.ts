/**
 * 提测记录列表（A13）：状态页签、项目筛选、按编号 / 版本 / Topic 搜索、来源标签。
 *
 * 页签的归并与标签是纯函数，直接断言取值；筛选、计数、工作区隔离连数据库跑一遍。
 *
 * 锁住的是这几条：
 *
 * - 页签只有 5 个，7 个提测状态一个不漏地归进 4 个实在状态（AC2：切「失败」只剩失败记录）；
 * - 页签上的数字与点进去看到的行出自同一次筛选，不会「显示 3 条、点开 0 条」；
 * - 工作区是硬边界，别人的提测不会出现在这里；
 * - 每行都取得到来源标签（平台创建 / 从 CRP 导入）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { prisma } from "../lib/db";
import {
  loadReleaseList,
  loadReleaseProjectOptions,
  parseStatusTab,
  releaseSourceLabel,
  releaseStatusLabel,
  RELEASE_STATUS_TABS,
  RELEASE_TAB_LABELS,
  RELEASE_TAB_STATUSES,
} from "../lib/releases";

const PREFIX = "zz887l";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const OTHER_WORKSPACE_SLUG = `${PREFIX}-other`;
const MANAGER_NAME = `${PREFIX}-manager`;
const KEY_A = `${PREFIX}-proj-a`;
const KEY_B = `${PREFIX}-proj-b`;

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectA: string;
  projectB: string;
};

let fixture: Fixture;

function versionOf(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

async function cleanup(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    where: { slug: { in: [WORKSPACE_SLUG, OTHER_WORKSPACE_SLUG] } },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.baseline.deleteMany({ where: { crpBranchId: { startsWith: PREFIX } } });
  await prisma.projectManager.deleteMany({ where: { workspace: { id: { in: workspaceIds } } } });
  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

type ReleaseSeed = {
  version: string;
  status: "pending" | "dispatching" | "building" | "success" | "partial_failure" | "failed" | "abandoned";
  source: "platform" | "imported";
  projectId: string;
  crpTopicId?: string;
  createdAt: string;
  packages: number;
};

async function createRelease(seed: ReleaseSeed, createdById: string): Promise<string> {
  const created = await prisma.release.create({
    data: {
      projectId: seed.projectId,
      version: seed.version,
      status: seed.status,
      source: seed.source,
      createdById,
      crpTopicId: seed.crpTopicId ?? null,
      createdAt: new Date(seed.createdAt),
    },
    select: { id: true },
  });

  for (let index = 0; index < seed.packages; index += 1) {
    await prisma.releasePackageSnapshot.create({
      data: {
        releaseId: created.id,
        packageName: `${PREFIX}-pkg-${index}`,
        attempt: 1,
        branch: "develop/eagle",
        commitSha: `${index}`.repeat(40).slice(0, 40),
        codeVersion: "1.0.0-1",
        releaseVersion: "1.0.0",
      },
    });
  }

  return created.id;
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });
  const otherWorkspace = await prisma.workspace.create({
    data: { slug: OTHER_WORKSPACE_SLUG, name: `${PREFIX} 别的工作区` },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} 创建人`,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: { crpBranchId: `${PREFIX}-branch`, name: `${PREFIX}-baseline` },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });
  const otherManager = await prisma.projectManager.create({
    data: { workspaceId: otherWorkspace.id, name: `${MANAGER_NAME}-other` },
    select: { id: true },
  });

  const projectA = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: KEY_A,
      name: `${PREFIX} 项目甲`,
    },
    select: { id: true },
  });
  const projectB = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: KEY_B,
      name: `${PREFIX} 项目乙`,
    },
    select: { id: true },
  });
  const projectOther = await prisma.project.create({
    data: {
      workspaceId: otherWorkspace.id,
      projectManagerId: otherManager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-proj-other`,
      name: `${PREFIX} 别人的项目`,
    },
    select: { id: true },
  });

  fixture = {
    workspaceId: workspace.id,
    otherWorkspaceId: otherWorkspace.id,
    projectA: projectA.id,
    projectB: projectB.id,
  };

  await createRelease(
    {
      version: versionOf("pending"),
      status: "pending",
      source: "platform",
      projectId: projectA.id,
      createdAt: "2026-11-19T01:00:00Z",
      packages: 2,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("imported"),
      status: "dispatching",
      source: "imported",
      projectId: projectA.id,
      crpTopicId: `${PREFIX}-8801`,
      createdAt: "2026-11-19T02:00:00Z",
      packages: 1,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("building"),
      status: "building",
      source: "platform",
      projectId: projectB.id,
      createdAt: "2026-11-19T03:00:00Z",
      packages: 1,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("failed"),
      status: "failed",
      source: "platform",
      projectId: projectA.id,
      createdAt: "2026-11-19T04:00:00Z",
      packages: 1,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("partial"),
      status: "partial_failure",
      source: "imported",
      projectId: projectB.id,
      createdAt: "2026-11-19T05:00:00Z",
      packages: 1,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("success"),
      status: "success",
      source: "platform",
      projectId: projectA.id,
      createdAt: "2026-11-19T06:00:00Z",
      packages: 3,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("abandoned"),
      status: "abandoned",
      source: "platform",
      projectId: projectB.id,
      createdAt: "2026-11-19T07:00:00Z",
      packages: 1,
    },
    user.id,
  );
  await createRelease(
    {
      version: versionOf("other"),
      status: "success",
      source: "platform",
      projectId: projectOther.id,
      createdAt: "2026-11-19T08:00:00Z",
      packages: 1,
    },
    user.id,
  );
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("页签只有 5 个，7 个提测状态一个不漏地归进 4 个实在状态", () => {
  assert.deepEqual([...RELEASE_STATUS_TABS], ["all", "queued", "building", "success", "failed"]);
  assert.equal(RELEASE_TAB_LABELS.all, "全部");
  assert.equal(RELEASE_TAB_LABELS.queued, "排队中");
  assert.equal(RELEASE_TAB_LABELS.building, "构建中");
  assert.equal(RELEASE_TAB_LABELS.success, "成功");
  assert.equal(RELEASE_TAB_LABELS.failed, "失败");

  const covered = new Set(RELEASE_TAB_STATUSES.all);
  assert.equal(covered.size, 7, "全部页签要覆盖 7 个状态，不能重复");
  assert.deepEqual([...RELEASE_TAB_STATUSES.failed].sort(), [
    "abandoned",
    "failed",
    "partial_failure",
  ]);
  assert.deepEqual([...RELEASE_TAB_STATUSES.queued].sort(), ["dispatching", "pending"]);
});

test("认不出的页签参数当「全部」，不报错", () => {
  assert.equal(parseStatusTab(undefined), "all");
  assert.equal(parseStatusTab(""), "all");
  assert.equal(parseStatusTab("nope"), "all");
  assert.equal(parseStatusTab("failed"), "failed");
});

test("状态与来源都有中文名，认不出的取值原样返回", () => {
  assert.equal(releaseStatusLabel("partial_failure"), "部分失败");
  assert.equal(releaseStatusLabel("dispatching"), "投递中");
  assert.equal(releaseStatusLabel("unknown"), "unknown");
  assert.equal(releaseSourceLabel("imported"), "从 CRP 导入");
  assert.equal(releaseSourceLabel("platform"), "平台创建");
  assert.equal(releaseSourceLabel("whatever"), "whatever");
});

test("全部页签列出本工作区的 7 条，别的工作区一条都不出现", async () => {
  const result = await loadReleaseList({ workspaceId: fixture.workspaceId, tab: "all" });

  assert.equal(result.rows.length, 7);
  assert.deepEqual(result.counts, { all: 7, queued: 2, building: 1, success: 1, failed: 3 });
  assert.ok(
    result.rows.every((row) => row.version !== versionOf("other")),
    "别的工作区的提测不该出现",
  );
});

test("切「失败」页签只剩失败、部分失败与已放弃（AC2）", async () => {
  const result = await loadReleaseList({ workspaceId: fixture.workspaceId, tab: "failed" });

  assert.deepEqual(
    result.rows.map((row) => row.status).sort(),
    ["abandoned", "failed", "partial_failure"],
  );
  assert.equal(result.counts.failed, 3);
});

test("每行都带来源，导入的那条标「从 CRP 导入」", async () => {
  const result = await loadReleaseList({ workspaceId: fixture.workspaceId, tab: "all" });
  const imported = result.rows.filter((row) => row.source === "imported");

  assert.deepEqual(
    imported.map((row) => releaseSourceLabel(row.source)),
    ["从 CRP 导入", "从 CRP 导入"],
  );
  assert.ok(result.rows.every((row) => row.createdByName === `${PREFIX} 创建人`));
});

test("按项目筛选只留这个项目的提测，页签数字跟着一起变", async () => {
  const result = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    projectId: fixture.projectB,
  });

  assert.deepEqual(
    result.rows.map((row) => row.version).sort(),
    [versionOf("abandoned"), versionOf("building"), versionOf("partial")].sort(),
  );
  assert.deepEqual(result.counts, { all: 3, queued: 0, building: 1, success: 0, failed: 2 });
});

test("按版本、Topic 编号与项目标识都能搜到", async () => {
  const byVersion = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    keyword: versionOf("building"),
  });
  assert.deepEqual(byVersion.rows.map((row) => row.version), [versionOf("building")]);

  const byTopic = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    keyword: `${PREFIX}-8801`,
  });
  assert.deepEqual(byTopic.rows.map((row) => row.version), [versionOf("imported")]);

  const byProjectKey = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    keyword: KEY_B,
  });
  assert.equal(byProjectKey.rows.length, 3);

  const noHit = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    keyword: `${PREFIX}-不存在`,
  });
  assert.equal(noHit.rows.length, 0);
  assert.equal(noHit.counts.all, 0);
});

test("软件数按当前轮计，被替换掉的旧轮不重复算", async () => {
  const result = await loadReleaseList({
    workspaceId: fixture.workspaceId,
    tab: "all",
    keyword: versionOf("success"),
  });
  const [row] = result.rows;

  assert.equal(row?.packageCount, 3);
});

test("项目下拉只列本工作区未删除的项目", async () => {
  const options = await loadReleaseProjectOptions(fixture.workspaceId);

  assert.deepEqual(options.map((item) => item.key).sort(), [KEY_A, KEY_B].sort());
  assert.ok(options.every((item) => item.name.startsWith(PREFIX)));
});
