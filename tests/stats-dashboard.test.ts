/**
 * 工作台统计与概览（A15）。
 *
 * 锁住的是这几条：
 *
 * - 四张统计卡的数字与数据库 count 一致，不是页面自己数行（AC1、MUST）；
 * - 换了工作区，数字跟着变，且只统计那个工作区（AC2、MUST）；
 * - 未配软件清单的项目、清单内依赖有环的项目出现在配置待办里（AC3）；
 * - 「本周」是最近 7 天的滚动窗口，窗口外的提测不计入统计卡，但仍可能出现在「最近提测」里；
 * - 最近提测按创建时间倒序只取 5 条，构建队列摘要只取 5 条任务。
 *
 * 注意：为了造出「清单内依赖成环」的项目，这里直接往 `package_dependency` 写了一个环。
 * A7 的保存入口会拒收有环的图，所以这条数据绕过了应用层校验；`after()` 必须把它删干净，
 * 否则后续 `saveDependencies` 的用例会因为整张图有环而全部失败（测试按文件串行跑，不会交叉污染）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { prisma } from "../lib/db";
import { loadDashboard, loadNavCounts } from "../lib/stats";

const PREFIX = "zz889s";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const OTHER_WORKSPACE_SLUG = `${PREFIX}-other`;
const MANAGER_NAME = `${PREFIX}-manager`;

/** 参照时刻固定在 2026-11-19 07:00 UTC，「本周」就是 11-12 07:00 之后的提测。 */
const NOW = new Date("2026-11-19T07:00:00Z");

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  /** 有软件清单、没有依赖环的项目。 */
  projectWithSoftware: string;
  /** 没配软件清单的项目。 */
  projectWithoutSoftware: string;
  /** 清单里有两个包互相依赖、构成环的项目。 */
  projectWithCycle: string;
  /** 已软删的项目，任何地方都不该出现。 */
  deletedProject: string;
  /** 主工作区里全部提测的 ID，用来验证队列摘要没有串到别的工作区。 */
  releaseIds: string[];
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

  await prisma.buildPollEvent.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.buildTask.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.packageDependency.deleteMany({
    where: { package: { name: { startsWith: PREFIX } } },
  });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.baseline.deleteMany({ where: { crpBranchId: { startsWith: PREFIX } } });
  await prisma.projectManager.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

type ReleaseSeed = {
  version: string;
  status: "pending" | "dispatching" | "building" | "success" | "partial_failure" | "failed" | "abandoned";
  projectId: string;
  createdAt: string;
  /** 快照状态；有快照时才会出现在构建队列里。 */
  snapshot?: { name: string; status: "pending" | "building" | "success" | "failed" };
  /** 构建任务状态；建了它才会被算进「等待构建」。 */
  buildStatus?: "pending" | "success";
};

/** 建一条提测（含可选的一轮快照与构建任务），返回提测 ID。 */
async function createRelease(seed: ReleaseSeed, createdById: string): Promise<string> {
  const created = await prisma.release.create({
    data: {
      projectId: seed.projectId,
      version: seed.version,
      status: seed.status,
      createdById,
      createdAt: new Date(seed.createdAt),
    },
    select: { id: true },
  });

  if (seed.snapshot !== undefined) {
    const snapshot = await prisma.releasePackageSnapshot.create({
      data: {
        releaseId: created.id,
        packageName: seed.snapshot.name,
        attempt: 1,
        branch: "develop/eagle",
        commitSha: seed.snapshot.name.padEnd(40, "0").slice(0, 40),
        codeVersion: "1.0.0-1",
        releaseVersion: "1.0.0",
        status: seed.snapshot.status,
      },
      select: { id: true },
    });

    if (seed.buildStatus !== undefined) {
      await prisma.buildTask.create({
        data: {
          releaseId: created.id,
          snapshotId: snapshot.id,
          status: seed.buildStatus,
        },
      });
    }
  }

  return created.id;
}

/**
 * 给一条提测补两轮同包名的快照：旧轮标 `superseded` 并挂一条「待开始」的构建任务，新轮是当前轮。
 *
 * 这就是 A17 换包之后的库内形态：`supersedeOldRounds` 只改快照，不碰 `build_task`，
 * 所以旧轮那条任务会一直停在 `pending`。工作台的「等待构建数」不能把它算进去。
 */
async function supersedeRound(releaseId: string, packageName: string): Promise<string> {
  const current = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId,
      packageName,
      attempt: 2,
      branch: "develop/eagle",
      commitSha: "c".repeat(40),
      codeVersion: "2.0.0-1",
      releaseVersion: "2.0.0",
      status: "building",
    },
    select: { id: true },
  });

  const replaced = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId,
      packageName,
      attempt: 1,
      branch: "develop/eagle",
      commitSha: "d".repeat(40),
      codeVersion: "1.9.9-1",
      releaseVersion: "1.9.9",
      status: "superseded",
      supersededById: current.id,
      supersededAt: new Date("2026-11-01T00:30:00Z"),
    },
    select: { id: true },
  });

  await prisma.buildTask.create({
    data: { releaseId, snapshotId: replaced.id, status: "pending" },
  });

  return releaseId;
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

  function projectInput(key: string, name: string, workspaceId: string, managerId: string) {
    return {
      workspaceId,
      projectManagerId: managerId,
      baselineId: baseline.id,
      key,
      name,
    };
  }

  const withSoftware = await prisma.project.create({
    data: projectInput(`${PREFIX}-proj-a`, `${PREFIX} 项目甲`, workspace.id, manager.id),
    select: { id: true },
  });
  const withoutSoftware = await prisma.project.create({
    data: projectInput(`${PREFIX}-proj-b`, `${PREFIX} 项目乙`, workspace.id, manager.id),
    select: { id: true },
  });
  const withCycle = await prisma.project.create({
    data: projectInput(`${PREFIX}-proj-c`, `${PREFIX} 项目丙`, workspace.id, manager.id),
    select: { id: true },
  });
  const deleted = await prisma.project.create({
    data: {
      ...projectInput(`${PREFIX}-proj-d`, `${PREFIX} 已删项目`, workspace.id, manager.id),
      deletedAt: new Date("2026-11-01T00:00:00Z"),
    },
    select: { id: true },
  });
  const otherProject = await prisma.project.create({
    data: projectInput(`${PREFIX}-proj-other`, `${PREFIX} 别的工作区的项目`, otherWorkspace.id, otherManager.id),
    select: { id: true },
  });

  // 甲：两个包，一条依赖边，没有环。
  const base = await prisma.package.create({
    data: {
      name: `${PREFIX}-pkg-base`,
      repoPath: `deepin/${PREFIX}-base`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });
  const app = await prisma.package.create({
    data: {
      name: `${PREFIX}-pkg-app`,
      repoPath: `deepin/${PREFIX}-app`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });
  await prisma.packageDependency.create({
    data: { packageId: app.id, upstreamPackageId: base.id },
  });
  await prisma.projectSoftware.createMany({
    data: [
      { projectId: withSoftware.id, packageId: base.id, trackedBranch: "develop/eagle" },
      { projectId: withSoftware.id, packageId: app.id, trackedBranch: "develop/eagle" },
    ],
  });

  // 丙：两个包互相依赖，构成环。
  const cycleA = await prisma.package.create({
    data: {
      name: `${PREFIX}-pkg-x`,
      repoPath: `deepin/${PREFIX}-x`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });
  const cycleB = await prisma.package.create({
    data: {
      name: `${PREFIX}-pkg-y`,
      repoPath: `deepin/${PREFIX}-y`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });
  await prisma.packageDependency.createMany({
    data: [
      { packageId: cycleA.id, upstreamPackageId: cycleB.id },
      { packageId: cycleB.id, upstreamPackageId: cycleA.id },
    ],
  });
  await prisma.projectSoftware.createMany({
    data: [
      { projectId: withCycle.id, packageId: cycleA.id, trackedBranch: "develop/eagle" },
      { projectId: withCycle.id, packageId: cycleB.id, trackedBranch: "develop/eagle" },
    ],
  });

  const releaseIds = [
    // 本周内：成功、失败、构建中各一条；已放弃一条在甲的项目外，用来凑满 5 条。
    await createRelease(
      {
        version: versionOf("success"),
        status: "success",
        projectId: withSoftware.id,
        createdAt: "2026-11-18T01:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-base`, status: "success" },
        buildStatus: "success",
      },
      user.id,
    ),
    await createRelease(
      {
        version: versionOf("failed"),
        status: "failed",
        projectId: withSoftware.id,
        createdAt: "2026-11-19T02:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-app`, status: "failed" },
      },
      user.id,
    ),
    await createRelease(
      {
        version: versionOf("building"),
        status: "building",
        projectId: withSoftware.id,
        createdAt: "2026-11-19T03:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-app`, status: "building" },
        buildStatus: "pending",
      },
      user.id,
    ),
    // 窗口外：11-10 创建，不计入「本周」，也不能出现在最近 5 条里。
    await createRelease(
      {
        version: versionOf("last-week"),
        status: "success",
        projectId: withSoftware.id,
        createdAt: "2026-11-10T01:00:00Z",
      },
      user.id,
    ),
    await createRelease(
      {
        version: versionOf("pending"),
        status: "pending",
        projectId: withCycle.id,
        createdAt: "2026-11-16T01:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-x`, status: "pending" },
        buildStatus: "pending",
      },
      user.id,
    ),
    await createRelease(
      {
        version: versionOf("abandoned"),
        status: "abandoned",
        projectId: withoutSoftware.id,
        createdAt: "2026-11-17T01:00:00Z",
      },
      user.id,
    ),
    // 残留的「待开始」构建任务之一：A17 换过包的提测，旧轮快照带着一条永远不会被推进的任务，
    // 提测本身还在跑（building）。创建时间放在窗口外，不干扰统计卡的窗口口径。
    await createRelease(
      {
        version: versionOf("superseded-round"),
        status: "building",
        projectId: withSoftware.id,
        createdAt: "2026-11-01T02:00:00Z",
      },
      user.id,
    ).then((releaseId) => supersedeRound(releaseId, `${PREFIX}-pkg-base`)),
    // 残留的「待开始」构建任务之二：取消提测只改快照与提测状态，构建任务留在 pending。
    await createRelease(
      {
        version: versionOf("canceled"),
        status: "abandoned",
        projectId: withSoftware.id,
        createdAt: "2026-11-01T03:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-app`, status: "failed" },
        buildStatus: "pending",
      },
      user.id,
    ),
    // 别的工作区：一条已成功（进成功率分母）、一条在构建（带一条待开始的构建任务）。
    // 只要数字串过来就一定被这几条抓住。
    await createRelease(
      {
        version: versionOf("other-success"),
        status: "success",
        projectId: otherProject.id,
        createdAt: "2026-11-19T04:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-other`, status: "success" },
        buildStatus: "success",
      },
      user.id,
    ),
    await createRelease(
      {
        version: versionOf("other-building"),
        status: "building",
        projectId: otherProject.id,
        createdAt: "2026-11-19T05:00:00Z",
        snapshot: { name: `${PREFIX}-pkg-other`, status: "building" },
        buildStatus: "pending",
      },
      user.id,
    ),
  ];

  fixture = {
    workspaceId: workspace.id,
    otherWorkspaceId: otherWorkspace.id,
    projectWithSoftware: withSoftware.id,
    projectWithoutSoftware: withoutSoftware.id,
    projectWithCycle: withCycle.id,
    deletedProject: deleted.id,
    releaseIds: releaseIds.slice(0, 8),
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("四张统计卡按提测状态计数，与数据库 groupBy 一致（AC1、FUNC-01）", async () => {
  const [statusRows, view] = await Promise.all([
    prisma.release.groupBy({
      by: ["status"],
      where: { project: { workspaceId: fixture.workspaceId } },
      _count: { _all: true },
    }),
    loadDashboard(fixture.workspaceId, { now: NOW }),
  ]);

  const countOf = (predicate: (status: string) => boolean): number =>
    statusRows.reduce((sum, row) => (predicate(row.status) ? sum + row._count._all : sum), 0);

  assert.equal(view.cards.inProgressReleases, countOf((status) => status === "dispatching" || status === "building"));
  assert.equal(view.cards.succeededReleases, countOf((status) => status === "success"));
  assert.equal(view.cards.failedReleases, countOf((status) => status === "failed" || status === "partial_failure"));
  assert.equal(view.cards.waitingReleases, countOf((status) => status === "pending"));

  // 库内主工作区 8 条：成功 1、失败 1、已放弃 2、构建中 2、排队中 1、换过包的构建中 1。
  assert.equal(view.cards.inProgressReleases, 2);
  assert.equal(view.cards.succeededReleases, 2);
  assert.equal(view.cards.failedReleases, 1);
  assert.equal(view.cards.waitingReleases, 1);
});

test("统计卡按状态计，不按时间窗收窄：把参照时刻挪远，数字不变", async () => {
  // 四张卡回答的是「现在有多少条在跑 / 成了 / 败了 / 等着」，没有「本周」这个口径，
  // 所以参照时刻挪到所有提测之后，数字也不该变（改了就会和 FUNC-01 的期望值对不上）。
  const view = await loadDashboard(fixture.workspaceId, {
    now: new Date("2026-12-31T00:00:00Z"),
  });

  assert.equal(view.cards.inProgressReleases, 2);
  assert.equal(view.cards.succeededReleases, 2);
  assert.equal(view.cards.failedReleases, 1);
  assert.equal(view.cards.waitingReleases, 1);
});

test("换成别的工作区后数字与清单都只来自那个工作区（AC2）", async () => {
  const view = await loadDashboard(fixture.otherWorkspaceId, { now: NOW });

  // 别的工作区两条：已成功 1、构建中 1。四张卡按状态计，与主工作区互不影响。
  assert.equal(view.cards.inProgressReleases, 1);
  assert.equal(view.cards.succeededReleases, 1);
  assert.equal(view.cards.failedReleases, 0);
  assert.equal(view.cards.waitingReleases, 0);

  assert.equal(view.recentReleases.length, 2);
  assert.equal(view.recentReleases[0]?.version, versionOf("other-building"));
  assert.deepEqual(
    view.projects.map((project) => project.key),
    [`${PREFIX}-proj-other`],
  );

  // 主工作区的提测一条都不许串进来。
  const foreignIds = new Set(view.queueTasks.map((task) => task.releaseId));
  for (const releaseId of fixture.releaseIds) {
    assert.equal(foreignIds.has(releaseId), false, releaseId);
  }
});

test("未配软件清单的项目出现在配置待办里，配了的不出现（AC3）", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });
  const keys = view.configTodo.missingSoftware.map((project) => project.key);

  assert.deepEqual(keys, [`${PREFIX}-proj-b`]);
});

test("清单内依赖有环的项目出现在配置待办里，没有环的项目不出现", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });

  assert.equal(view.configTodo.dependencyCycles.length, 1);
  const [flagged] = view.configTodo.dependencyCycles;

  assert.equal(flagged?.key, `${PREFIX}-proj-c`);

  // 环上的两个包首尾同名，顺序由第一个找到的环决定，不锁死方向。
  const names = (flagged?.cycle ?? "").split(" → ");
  assert.equal(names[0], names.at(-1));
  assert.deepEqual(
    [...new Set(names)].sort(),
    [`${PREFIX}-pkg-x`, `${PREFIX}-pkg-y`],
  );
});

test("最近提测按创建时间倒序只取 5 条，窗口外的那条被挤出去", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });

  assert.deepEqual(
    view.recentReleases.map((release) => release.version),
    [
      versionOf("building"),
      versionOf("failed"),
      versionOf("success"),
      versionOf("abandoned"),
      versionOf("pending"),
    ],
  );

  // 窗口外的那条虽然是甲最新的历史记录之一，但排不进来。
  assert.equal(
    view.recentReleases.some((release) => release.version === versionOf("last-week")),
    false,
  );
});

test("最近提测的每一行都带得出状态与来源的中文名", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });
  const building = view.recentReleases.find(
    (release) => release.version === versionOf("building"),
  );

  assert.equal(building?.statusLabel, "构建中");
  assert.equal(building?.statusTone, "is-run");
  assert.equal(building?.sourceLabel, "平台创建");
  assert.equal(building?.projectName, `${PREFIX} 项目甲`);
  // 最近提测表要显示这一轮的软件包数。
  assert.equal(building?.packageCount, 1);
});

test("构建队列摘要最多 5 条，只含未完结提测里的包", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });

  assert.ok(view.queueTasks.length <= 5);
  // 只有当前轮进队列：换过包的提测只留第二轮，旧轮那条 superseded 快照不出现。
  assert.deepEqual(
    view.queueTasks.map((task) => task.packageName).sort(),
    [`${PREFIX}-pkg-app`, `${PREFIX}-pkg-base`, `${PREFIX}-pkg-x`],
  );

  const buildingTask = view.queueTasks.find((task) => task.packageName === `${PREFIX}-pkg-app`);
  assert.equal(buildingTask?.stage, "构建中");
  assert.equal(buildingTask?.releaseVersion, versionOf("building"));
});

test("项目提测概况：经理、软件包数、依赖数、最近一次提测都在，软删的项目不出现", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });
  const byKey = new Map(view.projects.map((project) => [project.key, project]));

  assert.equal(byKey.has(`${PREFIX}-proj-d`), false);

  const withSoftware = byKey.get(`${PREFIX}-proj-a`);
  assert.equal(withSoftware?.managerName, MANAGER_NAME);
  assert.equal(withSoftware?.packageCount, 2);
  assert.equal(withSoftware?.dependencyCount, 1);
  assert.equal(withSoftware?.latestVersion, versionOf("building"));
  assert.equal(withSoftware?.latestStatusLabel, "构建中");
  assert.equal(withSoftware?.latestStatusTone, "is-run");

  const withoutSoftware = byKey.get(`${PREFIX}-proj-b`);
  assert.equal(withoutSoftware?.packageCount, 0);
  assert.equal(withoutSoftware?.dependencyCount, 0);
  assert.equal(withoutSoftware?.latestVersion, versionOf("abandoned"));
  assert.equal(withoutSoftware?.latestStatusLabel, "已放弃");
  assert.equal(withoutSoftware?.latestStatusTone, "is-wait");

  const withCycle = byKey.get(`${PREFIX}-proj-c`);
  assert.equal(withCycle?.packageCount, 2);
  // 互相依赖的两条边都算：环上的两个包各有一条依赖。
  assert.equal(withCycle?.dependencyCount, 2);
  assert.equal(withCycle?.latestVersion, versionOf("pending"));
  assert.equal(withCycle?.latestStatusLabel, "排队中");
});

test("侧栏徽标：提测总数与未跑完的提测数，都只算这个工作区", async () => {
  const [main, other] = await Promise.all([
    loadNavCounts(fixture.workspaceId),
    loadNavCounts(fixture.otherWorkspaceId),
  ]);

  // 主工作区 8 条：成功 2、失败 1、已放弃 2、构建中 2、排队中 1。
  assert.equal(main.releases, 8);
  // 未跑完 = 排队中 1 + 构建中 2（含换过包那条）。
  assert.equal(main.queue, 3);

  // 别的工作区两条：构建中 1、成功 1。
  assert.equal(other.releases, 2);
  assert.equal(other.queue, 1);
});

test("一次读出这批数字的时刻，页面标「数据截至」用它", async () => {
  const view = await loadDashboard(fixture.workspaceId, { now: NOW });

  assert.equal(view.generatedAt.toISOString(), NOW.toISOString());
});
