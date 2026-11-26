/**
 * 提测详情页的四个操作判据（MKACG-1011）：行级重投的可用性、撤回被锁的原因、快照明细导出。
 *
 * 都是纯函数，不连数据库：页面与服务端动作调用的就是这里测的同一份函数，
 * 所以这里锁住的说法就是用户会看到的说法。
 */

import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildRiskItems } from "../app/(app)/releases/[id]/detailView";
import {
  packageActionState,
  UNKNOWN_PACKAGE_STAGE,
  type PackageStage,
} from "../app/(app)/releases/[id]/retryState";
import {
  buildSnapshotDetailCsv,
  SNAPSHOT_DETAIL_COLUMNS,
  type ReleaseDetailPackage,
  type ReleaseDetailRepositoryRecord,
} from "../lib/releases";

const PREFIX = "zz1011";

function stage(overrides: Partial<PackageStage> = {}): PackageStage {
  return { phase: "failed", stage: "失败", blockedBy: null, ...overrides };
}

// ---------------------------------------------------------------------------
// 行级重投：只有失败与等待上游可点
// ---------------------------------------------------------------------------

test("构建失败的包可以单独重投", () => {
  assert.deepEqual(packageActionState(stage({ phase: "failed", stage: "失败" })), {
    retryable: true,
    reason: null,
  });
});

test("在等上游的包也可以点，点了只是把调度推进一格", () => {
  assert.deepEqual(packageActionState(stage({ phase: "waiting", stage: "等待依赖" })), {
    retryable: true,
    reason: null,
  });
});

test("已成功的包禁用，并写明不用重投", () => {
  const state = packageActionState(stage({ phase: "success", stage: "成功" }));

  assert.equal(state.retryable, false);
  assert.match(state.reason ?? "", /已成功/);
});

test("正在投递或构建的包禁用，原因里带上当前阶段", () => {
  const building = packageActionState(stage({ phase: "running", stage: "构建中" }));

  assert.equal(building.retryable, false);
  assert.match(building.reason ?? "", /构建中/);

  const dispatching = packageActionState(stage({ phase: "running", stage: "投递中" }));

  assert.equal(dispatching.retryable, false);
  assert.match(dispatching.reason ?? "", /投递中/);
});

test("被上游拖垮的包禁用，原因指名是哪个上游", () => {
  const state = packageActionState(
    stage({ phase: "failed", stage: "已阻断（上游 a 失败）", blockedBy: "a" }),
  );

  assert.equal(state.retryable, false);
  assert.match(state.reason ?? "", /上游 a/);
});

test("还没投递的包禁用，等调度器自己投", () => {
  const state = packageActionState(stage({ phase: "queued", stage: "待投递" }));

  assert.equal(state.retryable, false);
  assert.match(state.reason ?? "", /自动投递/);
});

test("读不到这个包的阶段时按禁用处理，不猜它能重投", () => {
  assert.equal(packageActionState(UNKNOWN_PACKAGE_STAGE).retryable, false);
});

// ---------------------------------------------------------------------------
// 撤回被锁：原因常驻在时间线区域
// ---------------------------------------------------------------------------

test("撤回没被锁时不出撤回风险", () => {
  assert.deepEqual(
    buildRiskItems({ status: "queued", lockReason: null, retract: null }),
    [],
  );
});

test("撤回被锁时出一条风险，标题用按钮文案、正文用服务端那句原因", () => {
  const reason = "这条提测已经转测（CRP 工作流进度 20：转测试中），转测之后不能再取消。";
  const items = buildRiskItems({
    status: "success",
    lockReason: null,
    retract: { label: "取消提测", reason },
  });

  assert.deepEqual(
    items.map((item) => item.key),
    ["retract"],
  );
  assert.equal(items[0]?.title, "现在不能取消提测");
  assert.equal(items[0]?.body, reason, "原因原样显示，页面不改写");
});

test("构建失败、改不了、撤不回时三条都出，撤回那条在最后", () => {
  const items = buildRiskItems({
    status: "failed",
    lockReason: "有软件包正在投递，等这一轮投递结束再更新。",
    retract: { label: "放弃主题", reason: "已经转测的主题不能放弃。" },
  });

  assert.deepEqual(
    items.map((item) => item.key),
    ["build", "lock", "retract"],
  );
  assert.equal(items[2]?.title, "现在不能放弃主题");
});

// ---------------------------------------------------------------------------
// 快照明细导出：每包一行，含分支、Commit、代码版本、CRP 版本、架构、结果
// ---------------------------------------------------------------------------

function pkg(overrides: Partial<ReleaseDetailPackage> = {}): ReleaseDetailPackage {
  return {
    packageName: `${PREFIX}-kwin`,
    repoPath: "deepin-kde/kwin",
    attempt: 1,
    branch: "develop/eagle",
    codeVersion: "1.0.0-1",
    repoVersion: null,
    releaseVersion: "1.0.0",
    customTag: false,
    baselineCommit: null,
    commitSha: "a".repeat(40),
    commitMessage: "修一个问题",
    commitAuthor: "张三",
    commitError: null,
    ...overrides,
  };
}

function record(
  overrides: Partial<ReleaseDetailRepositoryRecord> = {},
): ReleaseDetailRepositoryRecord {
  return {
    packageName: `${PREFIX}-kwin`,
    crpReleaseId: "8801",
    crpBuildId: null,
    crpStatusName: null,
    crpTag: "1.0.0.2",
    crpBaseTag: "1.0.0",
    repositoryUrl: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

function csvRows(csv: string): string[] {
  return csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
}

test("快照明细的表头是那 7 列，带 BOM，行数与软件包数一致", () => {
  const csv = buildSnapshotDetailCsv({
    packages: [pkg(), pkg({ packageName: `${PREFIX}-dde` })],
    repositoryRecords: [record()],
    tasks: [],
  });

  assert.ok(csv.startsWith("\uFEFF"), "带 BOM，Excel 打开中文不乱码");
  assert.deepEqual([...SNAPSHOT_DETAIL_COLUMNS], [
    "软件包",
    "分支",
    "Commit",
    "代码版本",
    "CRP 仓库版本",
    "架构",
    "结果",
  ]);

  const rows = csvRows(csv);

  assert.equal(rows[0], SNAPSHOT_DETAIL_COLUMNS.join(","));
  assert.equal(rows.length, 3);
  assert.ok(rows.slice(1).every((row) => row.split(",").length === 7));
});

test("每行带分支、Commit、代码版本、CRP 仓库版本、架构与结果", () => {
  const csv = buildSnapshotDetailCsv({
    packages: [pkg()],
    repositoryRecords: [record()],
    tasks: [
      {
        packageName: `${PREFIX}-kwin`,
        stage: "失败",
        arches: [{ arch: "amd64" }, { arch: "arm64" }],
      },
    ],
  });

  const row = csvRows(csv)[1] ?? "";

  assert.ok(row.includes(`${PREFIX}-kwin（deepin-kde/kwin）`), "软件包与仓库路径");
  assert.ok(row.includes("develop/eagle"), "分支");
  assert.ok(row.includes("a".repeat(40)), "Commit");
  assert.ok(row.includes("1.0.0-1"), "代码版本");
  assert.ok(row.includes("1.0.0.2"), "CRP 仓库版本取 CRP 自己记的那个");
  assert.ok(row.includes("amd64、arm64"), "架构按顺序列出");
  assert.ok(row.endsWith("失败"), "最后一列是结果");
});

test("还没同步过 CRP 时退回提交上去的版本；两样都没有写破折号", () => {
  const csv = buildSnapshotDetailCsv({
    packages: [pkg()],
    repositoryRecords: [record({ crpTag: null, crpBaseTag: "1.0.0" })],
    tasks: [],
  });

  assert.ok((csvRows(csv)[1] ?? "").includes("1.0.0"));

  const empty = buildSnapshotDetailCsv({
    packages: [pkg()],
    repositoryRecords: [],
    tasks: [],
  });
  const missing = csvRows(empty)[1] ?? "";

  assert.ok(missing.includes(",—,—"), "没有记录也没有构建时，CRP 版本与结果都写破折号");
});

test("快照明细也挡公式注入", () => {
  const csv = buildSnapshotDetailCsv({
    packages: [pkg({ packageName: "=HYPERLINK(1)" })],
    repositoryRecords: [record({ packageName: "=HYPERLINK(1)", crpTag: "=1+1" })],
    tasks: [],
  });
  const row = csvRows(csv)[1] ?? "";

  assert.ok(row.startsWith("'=HYPERLINK(1)"), "包名以 = 开头时加前导单引号");
  assert.ok(row.includes(",'=1+1,"), "CRP 仓库版本同样要挡");
});

// ---------------------------------------------------------------------------
// 确认弹窗的挂载位置（评审返工：弹窗落在视口外）
// ---------------------------------------------------------------------------

/**
 * 三个确认弹窗都必须走 `./detailModal`（`createPortal` 到 `document.body`）。
 *
 * 用源码断言而不是渲染断言，与 `tests/webhook-manager-dialogs.test.ts` 同一条取舍：这类缺陷
 * 是「DOM 挂错层」，在 jsdom 里量不出真实几何，而真浏览器量一次就够。锁住的是这一层关系 ——
 * 一旦有人把 `Modal` 直接内联回页面，`.scrim`（`position: absolute`）的定位基准就会退化成
 * `.topbar`（`backdrop-filter` 会给 `fixed` 后代建立包含块）或初始包含块，弹窗又跑到视口外。
 */
test("详情页的三个确认弹窗都挂到 document.body 上", () => {
  const forms = [
    "app/(app)/releases/[id]/retryPackageForm.tsx",
    "app/(app)/releases/[id]/cancelReleaseForm.tsx",
    "app/(app)/releases/[id]/abandonTopicForm.tsx",
  ];

  for (const path of forms) {
    const source = readFileSync(join(process.cwd(), path), "utf8");

    assert.match(source, /<DetailModal\b/u, `${path} 应使用 DetailModal`);
    assert.doesNotMatch(
      source,
      /from "@\/components\/modal"/u,
      `${path} 不应直接内联 Modal：弹窗会落在视口外`,
    );
  }

  const portal = readFileSync(
    join(process.cwd(), "app/(app)/releases/[id]/detailModal.tsx"),
    "utf8",
  );

  assert.match(portal, /createPortal\(/u, "DetailModal 必须用 createPortal");
  assert.match(portal, /document\.body/u, "DetailModal 必须挂到 document.body");
  assert.match(portal, /className="modal-root"/u, "DetailModal 必须包一层 .modal-root");
});
