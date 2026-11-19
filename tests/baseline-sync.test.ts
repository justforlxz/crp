/**
 * 基线同步的集成测试：真连数据库，外部系统用假客户端替换。
 *
 * 锁的是几条不能破的约定：
 *
 * - 分支列表按 `crpBranchId` 幂等写入，本次没出现的标「已消失」而不是删行；
 * - 同步失败只写 `sync_run`，`baseline` 与 `baseline_package_version` 一行不改，
 *   且 `syncedAt` 不前移（失败的同步不能看起来像同步过）；
 * - 软件包版本整条基线一次取回，不逐包发请求；
 * - 只刷新被项目选中的基线。
 *
 * 用到基线一律用本文件的固定 `crpBranchId`，跑完自己清掉，不影响种子数据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { POST } from "../app/api/jobs/baseline-sync/route";
import { listBaselines } from "../lib/baselines";
import type { CrpBranch } from "../lib/integrations/crp";
import type { BaselinePackage, BaselineRepository } from "../lib/integrations/shuttle";
import {
  BASELINE_PACKAGE_TTL_MS,
  planPackageRefresh,
  runBaselineSync,
  syncBaselineList,
  syncBaselinePackages,
  type PackageRefreshCandidate,
} from "../lib/jobs/baseline-sync";
import { prisma } from "../lib/db";

const PREFIX = "zz883";

/**
 * 测试用的假时钟固定在 2035 年。
 *
 * 与种子的同步时间（2026-11-18）隔得足够远：清理时按 `startedAt` 删同步记录不会碰到种子，
 * 读「最近一次同步」时测试记录一定排在前面。每次取时间往前走一分钟，保证先后有序。
 */
const TEST_WINDOW_START = new Date("2035-01-01T00:00:00Z");
let clockMs = TEST_WINDOW_START.getTime();

function tick(): Date {
  clockMs += 60_000;
  return new Date(clockMs);
}

/** 足够大的缓存有效期：把种子基线挡在「已过期」之外，只让本用例的两条基线参与刷新。 */
const NEVER_EXPIRES_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const BRANCH_IDS = [
  "900883",
  "900884",
  "900885",
  "900886",
  "900887",
  "900888",
  "900889",
];
const WORKSPACE_SLUG = `${PREFIX}-workspace`;

function branch(id: number, name: string, extra: Partial<CrpBranch> = {}): CrpBranch {
  return {
    id,
    name,
    description: `${name} 的说明`,
    repoType: "deb",
    isCheck: false,
    raw: { ID: id, Name: name },
    ...extra,
  };
}

function fakeCrp(source: CrpBranch[] | Error) {
  return {
    async listBranches(): Promise<CrpBranch[]> {
      if (source instanceof Error) {
        throw source;
      }

      return source;
    },
  };
}

/**
 * 假的 Shuttle 客户端：返回固定的软件包版本与架构列表。
 *
 * 架构默认带上 `source`（实测 Shuttle 就会返回它），用来验证同步写库时被去掉。
 */
function fakeShuttle(
  source: BaselinePackage[] | Error,
  arches: string[] = ["amd64", "source", "sw_64"],
) {
  const calls: string[] = [];

  return {
    calls,
    async getBaselineRepository(baseline: string): Promise<BaselineRepository> {
      calls.push(baseline);

      if (source instanceof Error) {
        throw source;
      }

      return {
        info: { reponame: baseline, repotype: "deb", addresses: [], arches },
        packages: source,
      };
    },
  };
}

after(async () => {
  const baselines = await prisma.baseline.findMany({
    where: { crpBranchId: { in: BRANCH_IDS } },
    select: { id: true },
  });
  const ids = baselines.map((item) => item.id);

  // 顺序按外键依赖：项目引用基线与项目经理，先删项目。
  await prisma.project.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.projectManager.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.baseline.deleteMany({ where: { id: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });
  await prisma.syncRun.deleteMany({
    where: { OR: [{ targetId: { in: ids } }, { startedAt: { gte: TEST_WINDOW_START } }] },
  });

  // 测试里的假 CRP 只返回本用例的分支，种子基线会被顺带标成「已消失」，这里复原。
  await prisma.baseline.updateMany({
    where: { crpBranchId: { notIn: BRANCH_IDS }, missingAt: { not: null } },
    data: { missingAt: null },
  });

  await prisma.$disconnect();
});

test("planPackageRefresh 只挑「在 CRP 里、被项目选中、缓存过期」的基线", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const stale = new Date(now.getTime() - BASELINE_PACKAGE_TTL_MS - 1);
  const fresh = new Date(now.getTime() - BASELINE_PACKAGE_TTL_MS + 1);

  const baselines: PackageRefreshCandidate[] = [
    { id: "stale-selected", name: "b-stale", syncedAt: stale, missingAt: null },
    { id: "fresh-selected", name: "a-fresh", syncedAt: fresh, missingAt: null },
    { id: "never-synced", name: "c-never", syncedAt: null, missingAt: null },
    { id: "not-selected", name: "d-unused", syncedAt: stale, missingAt: null },
    { id: "gone", name: "e-gone", syncedAt: stale, missingAt: now },
  ];
  const selected = new Set([
    "stale-selected",
    "fresh-selected",
    "never-synced",
    "gone",
  ]);

  const targets = planPackageRefresh(baselines, selected, { now });

  // 未过期、没被选中、已消失的都不在其中；结果按基线名排序（b-stale 在 c-never 之前）。
  assert.deepEqual(
    targets.map((item) => item.id),
    ["stale-selected", "never-synced"],
  );

  const forced = planPackageRefresh(baselines, selected, { now, force: true });
  assert.deepEqual(
    forced.map((item) => item.id),
    ["fresh-selected", "stale-selected", "never-synced"],
  );
});

test("分支列表同步：按 crpBranchId 幂等写入，消失的分支标「已消失」而不是删行", async () => {
  const crp = fakeCrp([
    branch(900883, `${PREFIX}-a`, { description: "第一条", isCheck: true }),
    branch(900884, `${PREFIX}-b`),
  ]);

  const first = await syncBaselineList(crp, { trigger: "manual", now: tick() });

  // `missingCount` 不在这里断言：假 CRP 只返回本用例的分支，库里其它基线也会被标成已消失，
  // 具体条数取决于跑之前库里的状态（第一次跑与重复跑不同）。消失标记本身在下面逐条断言。
  assert.equal(first.status, "success");
  assert.equal(first.itemCount, 2);
  assert.equal(first.errorMessage, null);

  const written = await prisma.baseline.findMany({
    where: { crpBranchId: { in: ["900883", "900884"] } },
    orderBy: { crpBranchId: "asc" },
  });

  assert.equal(written.length, 2);
  assert.equal(written[0].name, `${PREFIX}-a`);
  assert.equal(written[0].description, "第一条");
  assert.equal(written[0].isCheck, true);
  assert.equal(written[0].missingAt, null);
  assert.equal(written[1].isCheck, false);

  // 第二次 CRP 只返回第一条，第二条必须留下来并标成「已消失」。
  const second = await syncBaselineList(fakeCrp([branch(900883, `${PREFIX}-a`)]), {
    trigger: "schedule",
    now: tick(),
  });

  assert.equal(second.itemCount, 1);
  assert.ok(second.missingCount >= 1, "本次没出现在列表里的基线至少要标一条");

  const afterSecond = await prisma.baseline.findMany({
    where: { crpBranchId: { in: ["900883", "900884"] } },
    orderBy: { crpBranchId: "asc" },
  });

  assert.equal(afterSecond.length, 2);
  assert.equal(afterSecond[0].missingAt, null);
  assert.notEqual(afterSecond[1].missingAt, null);
});

test("分支列表同步失败：旧数据一行不改，本次同步记成失败并留下原因", async () => {
  await syncBaselineList(fakeCrp([branch(900885, `${PREFIX}-keep`)]), {
    trigger: "schedule",
    now: tick(),
  });

  const failed = await syncBaselineList(
    fakeCrp(new Error("CRP 返回 502 Bad Gateway")),
    { trigger: "manual", now: tick() },
  );

  assert.equal(failed.status, "failed");
  assert.equal(failed.itemCount, 0);
  assert.match(failed.errorMessage ?? "", /502/);

  const kept = await prisma.baseline.findUnique({
    where: { crpBranchId: "900885" },
  });

  // 没有清表，也没有被标成「已消失」。
  assert.notEqual(kept, null);
  assert.equal(kept?.name, `${PREFIX}-keep`);
  assert.equal(kept?.missingAt, null);

  const run = await prisma.syncRun.findFirst({
    where: { kind: "baseline_list", status: "failed", startedAt: { gte: TEST_WINDOW_START } },
    orderBy: { startedAt: "desc" },
  });

  assert.match(run?.errorMessage ?? "", /502/);
  assert.notEqual(run?.finishedAt, null);
});

test("软件包版本同步：整条基线一次取回，缓存按包名覆盖，仓库里没有的包被清掉", async () => {
  const now = tick();
  const created = await prisma.baseline.create({
    data: {
      crpBranchId: "900886",
      name: `${PREFIX}-packages`,
      description: "软件包同步用例",
      repoType: "deb",
      isCheck: false,
      syncedAt: new Date(now.getTime() - BASELINE_PACKAGE_TTL_MS * 2),
    },
  });

  await prisma.baselinePackageVersion.createMany({
    data: [
      { baselineId: created.id, packageName: "kwin", version: "1.0-1", fetchedAt: now },
      { baselineId: created.id, packageName: "gone-pkg", version: "2.0-1", fetchedAt: now },
    ],
  });

  const shuttle = fakeShuttle([
    { name: "kwin", version: "9.9.9-1" },
    { name: "dde-dock", version: "3.0-1" },
  ]);

  const results = await syncBaselinePackages(
    shuttle,
    [{ id: created.id, name: created.name, syncedAt: created.syncedAt, missingAt: null }],
    { trigger: "manual", now },
  );

  // 一条基线只问一次 Shuttle，不逐包发请求。
  assert.deepEqual(shuttle.calls, [created.name]);
  assert.deepEqual(results, [
    {
      baselineId: created.id,
      name: created.name,
      status: "success",
      itemCount: 2,
      errorMessage: null,
    },
  ]);

  const versions = await prisma.baselinePackageVersion.findMany({
    where: { baselineId: created.id },
    orderBy: { packageName: "asc" },
  });

  assert.deepEqual(
    versions.map((item) => [item.packageName, item.version]),
    [
      ["dde-dock", "3.0-1"],
      ["kwin", "9.9.9-1"],
    ],
  );

  const after = await prisma.baseline.findUnique({ where: { id: created.id } });
  assert.equal(after?.syncedAt?.getTime(), now.getTime());
  // 架构列表与版本一起来自同一次 repo/info：去掉了 `source`，其余按字母排序。
  assert.deepEqual(after?.arches, ["amd64", "sw_64"]);
});

test("软件包版本同步：索引为空算成功、缓存清空（分支还在但交付仓库还没有源码包）", async () => {
  const now = tick();
  const created = await prisma.baseline.create({
    data: {
      crpBranchId: "900889",
      name: `${PREFIX}-empty`,
      repoType: "deb",
      syncedAt: new Date(now.getTime() - BASELINE_PACKAGE_TTL_MS * 2),
    },
  });

  await prisma.baselinePackageVersion.create({
    data: { baselineId: created.id, packageName: "kwin", version: "1.0-1", fetchedAt: now },
  });

  const shuttle = fakeShuttle([]);
  const results = await syncBaselinePackages(
    shuttle,
    [{ id: created.id, name: created.name, syncedAt: created.syncedAt, missingAt: null }],
    { trigger: "schedule", now },
  );

  assert.equal(results[0].status, "success");
  assert.equal(results[0].itemCount, 0);

  const versions = await prisma.baselinePackageVersion.count({
    where: { baselineId: created.id },
  });
  assert.equal(versions, 0);

  const after = await prisma.baseline.findUnique({ where: { id: created.id } });
  assert.equal(after?.syncedAt?.getTime(), now.getTime());
  // 架构列表与版本一起来自同一次 repo/info：去掉了 `source`，其余按字母排序。
  assert.deepEqual(after?.arches, ["amd64", "sw_64"]);
});

test("软件包版本同步失败：缓存与 syncedAt 保持上一次成功的值，状态显示「同步失败」", async () => {
  const baseline = await prisma.baseline.findUnique({
    where: { crpBranchId: "900886" },
    select: { id: true, name: true, syncedAt: true },
  });
  assert.notEqual(baseline, null);

  // 失败前把库里已有的架构列表改成可辨认的值：同步失败时它必须原样留着。
  await prisma.baseline.update({
    where: { id: baseline!.id },
    data: { arches: ["amd64"] },
  });

  const shuttle = fakeShuttle(new Error("下载软件包索引失败：HTTP 502"), ["arm64"]);
  const results = await syncBaselinePackages(
    shuttle,
    [{ id: baseline!.id, name: baseline!.name, syncedAt: baseline!.syncedAt, missingAt: null }],
    { trigger: "schedule", now: tick() },
  );

  assert.equal(results[0].status, "failed");
  assert.match(results[0].errorMessage ?? "", /502/);

  const versions = await prisma.baselinePackageVersion.findMany({
    where: { baselineId: baseline!.id },
    orderBy: { packageName: "asc" },
  });

  // 上一次成功写入的两条记录还在，版本没被改成空。
  assert.deepEqual(
    versions.map((item) => [item.packageName, item.version]),
    [
      ["dde-dock", "3.0-1"],
      ["kwin", "9.9.9-1"],
    ],
  );

  const after = await prisma.baseline.findUnique({
    where: { id: baseline!.id },
    select: { syncedAt: true, arches: true },
  });

  // 失败的同步不得把 syncedAt 前移，也不能覆盖上一次成功写入的架构列表。
  assert.equal(after?.syncedAt?.getTime(), baseline!.syncedAt?.getTime());
  assert.deepEqual(after?.arches, ["amd64"]);

  const listed = (await listBaselines()).find((item) => item.id === baseline!.id);
  assert.equal(listed?.state, "failed");
  assert.match(listed?.latestError ?? "", /502/);
});

test("完整同步：只刷新被项目选中的基线", async () => {
  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
  });
  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: `${PREFIX}-经理` },
  });
  const selected = await prisma.baseline.create({
    data: { crpBranchId: "900887", name: `${PREFIX}-selected`, repoType: "deb" },
  });
  const unselected = await prisma.baseline.create({
    data: { crpBranchId: "900888", name: `${PREFIX}-unselected`, repoType: "deb" },
  });

  await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: selected.id,
      key: `${PREFIX}-project`,
      name: `${PREFIX} 项目`,
    },
  });

  const shuttle = fakeShuttle([{ name: "kwin", version: "4:5.27.2.213-1" }]);
  const summary = await runBaselineSync({
    trigger: "schedule",
    // 种子基线都过期了，把 TTL 拉到不可能到达，让这次同步只碰本用例的两条基线。
    ttlMs: NEVER_EXPIRES_MS,
    now: tick(),
    crp: fakeCrp([
      branch(900887, `${PREFIX}-selected`),
      branch(900888, `${PREFIX}-unselected`),
      branch(900883, `${PREFIX}-a`),
    ]),
    shuttle,
  });

  // 没被项目选中的基线不发请求；注入客户端时不统计请求数。
  assert.deepEqual(shuttle.calls, [`${PREFIX}-selected`]);
  assert.equal(summary.packages.length, 1);
  assert.equal(summary.packages[0].name, `${PREFIX}-selected`);
  assert.equal(summary.requests, null);
  assert.equal(summary.list.status, "success");

  const refreshed = await prisma.baseline.findUnique({ where: { id: selected.id } });
  const untouched = await prisma.baseline.findUnique({ where: { id: unselected.id } });

  assert.notEqual(refreshed?.syncedAt, null);
  assert.equal(untouched?.syncedAt, null);
  // 只刷新被选中的那条：它的架构列表写进来了，没被选中的那条仍是空数组。
  assert.deepEqual(refreshed?.arches, ["amd64", "sw_64"]);
  assert.deepEqual(untouched?.arches, []);

  const version = await prisma.baselinePackageVersion.findUnique({
    where: {
      baselineId_packageName: { baselineId: selected.id, packageName: "kwin" },
    },
  });
  assert.equal(version?.version, "4:5.27.2.213-1");
});

test("定时任务入口：没配 token 一律 401，填错 token 也是 401", async () => {
  const saved = process.env.SYNC_JOB_TOKEN;

  try {
    delete process.env.SYNC_JOB_TOKEN;

    const missing = await POST(
      new Request("http://localhost/api/jobs/baseline-sync", { method: "POST" }),
    );
    assert.equal(missing.status, 401);

    process.env.SYNC_JOB_TOKEN = "zz883-sync-token";

    const wrong = await POST(
      new Request("http://localhost/api/jobs/baseline-sync", {
        method: "POST",
        headers: { Authorization: "Bearer zz883-other-token" },
      }),
    );
    assert.equal(wrong.status, 401);
  } finally {
    if (saved === undefined) {
      delete process.env.SYNC_JOB_TOKEN;
    } else {
      process.env.SYNC_JOB_TOKEN = saved;
    }
  }
});
