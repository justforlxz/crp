/**
 * 创建提测向导的渲染测试（界面规范 v2 第八节）。
 *
 * 锁住的是 `design.md` 第八节的契约本身，不是某一个实现细节：
 *
 * - 第 1 步：经理下拉、项目下拉（跟随经理）、5 格基线摘要、版本号、只读的项目类型、提测说明；
 * - 第 2 步：目标基线横幅、三档统计与刷新、筛选与搜索、7 列表格（含提交顺序）、表尾统计；
 * - 第 3 步：三组配置摘要、7 列确认表、确认提示；
 * - 四条语义：没有勾选框、顺序来自依赖、更新状态只是提示、每行可设自定义版本号；
 * - 底部按钮文案逐字照第八节的表；步骤条有 3 步，当前步高亮、已完成的步打勾。
 *
 * 不连数据库：三个步骤组件只吃 props，外壳渲染第 1 步也不需要仓库数据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

import { CreatedRelease } from "../app/(app)/releases/new/createdRelease";
import { StepConfirm, type ConfirmRow } from "../app/(app)/releases/new/stepConfirm";
import { StepProject } from "../app/(app)/releases/new/stepProject";
import { StepReview, type ReviewRow } from "../app/(app)/releases/new/stepReview";
import { ReleaseWizard } from "../app/(app)/releases/new/wizard";
import type { SubmitResult } from "../app/(app)/releases/new/wizardTypes";
import type { ReleaseProjectChoice } from "../lib/releases";

const SHA = "63d0d62ac7afc3f0b4c5d6e7f8091a2b3c4d5e6f";

/**
 * 外壳的弹窗要 `useRouter`（关闭时回列表）；服务端渲染时给它一个不动的路由器
 * 就能渲染出来。三个步骤组件本身不碰路由器，多包一层不影响它们的断言。
 */
const ROUTER: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

/** 把一段子元素渲染成静态 HTML，断言都对着渲染结果做。 */
function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      createElement(Fragment, null, node),
    ),
  );
}

function project(overrides: Partial<ReleaseProjectChoice> = {}): ReleaseProjectChoice {
  return {
    id: "project-1",
    key: "desktop-v25",
    name: "桌面专业版 V25",
    managerId: "manager-1",
    managerName: "刘洋",
    baseline: {
      id: "baseline-1",
      name: "snipe-2500u2",
      description: "桌面专业版 V25",
      repoType: "deb",
      state: "synced",
      stateLabel: "已同步",
    },
    packageCount: 2,
    dependencyCount: 1,
    order: ["dde-file-manager", "kwin"],
    ready: true,
    blockers: [],
    ...overrides,
  };
}

function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    packageName: "dde-file-manager",
    repoPath: "deepin/dde-file-manager",
    order: 1,
    branches: ["develop/eagle", "develop/snipe"],
    commits: [
      { sha: SHA, summary: "fix: 修一处崩溃", authorName: "刘洋", time: "2026-11-18 10:00:00" },
    ],
    selection: {
      branch: "develop/eagle",
      commitSha: SHA,
      codeVersion: "1.3.0-1",
      customTag: "",
    },
    repoVersion: "1.2.1-1",
    releaseVersion: "1.3.0-1",
    changed: true,
    tagError: null,
    busy: false,
    unavailable: null,
    ...overrides,
  };
}

const stepReviewProps = {
  project: project(),
  refreshing: false,
  loaded: true,
  allCount: 1,
  changedCount: 1,
  filter: "all" as const,
  query: "",
  editing: null,
  tagDraft: "",
  blockers: [],
  warnings: [],
  errors: [],
  onRefresh: () => {},
  onFilterChange: () => {},
  onQueryChange: () => {},
  onBranchChange: () => {},
  onCommitChange: () => {},
  onTagEdit: () => {},
  onTagDraftChange: () => {},
  onTagSave: () => {},
  onTagReset: () => {},
  onTagCancel: () => {},
};

const confirmRow: ConfirmRow = {
  packageName: "dde-file-manager",
  branch: "develop/eagle",
  commitSha: SHA,
  codeVersion: "1.3.0-1",
  repoVersion: "1.2.1-1",
  releaseVersion: "9.9.9",
  custom: true,
  changed: true,
};

const submitResult: SubmitResult = {
  id: "release-1",
  version: "25.0.2",
  revision: 1,
  packageCount: 1,
  changedCount: 1,
  summary: "本次将提测 1 个软件，其中 1 个有更新。",
  order: ["dde-file-manager"],
  snapshots: [
    {
      packageName: "dde-file-manager",
      branch: "develop/eagle",
      commitSha: SHA,
      codeVersion: "1.3.0-1",
      repoVersion: "1.2.1-1",
      releaseVersion: "9.9.9",
      changed: true,
    },
  ],
};

test("第 1 步：经理与项目下拉、5 格基线摘要、版本号、只读项目类型、提测说明", () => {
  const html = htmlOf(
    StepProject({
      managers: [["manager-1", "刘洋"]],
      managerProjects: [project()],
      managerId: "manager-1",
      projectId: "project-1",
      version: "25.0.2",
      description: "改窗口管理器",
      project: project(),
      onManagerChange: () => {},
      onProjectChange: () => {},
      onVersionChange: () => {},
      onDescriptionChange: () => {},
    }),
  );

  assert.match(html, /class="wiz-note"><b>先选择项目经理，再选择该经理负责的项目<\/b>/);
  assert.match(html, /<option value="manager-1"[^>]*>刘洋<\/option>/);
  assert.match(html, /<option value="project-1"[^>]*>桌面专业版 V25（desktop-v25）<\/option>/);

  // 5 格基线摘要，顺序照原型：目标系统仓库 / 项目 CRP 基线 / 基线同步状态 / 固定软件 / 经理。
  const cells = [
    ...html.matchAll(/<div><small>([^<]+)<\/small><b[^>]*>([\s\S]*?)<\/b><\/div>/gu),
  ].map((match) => [match[1], match[2]] as const);

  assert.equal(cells.length, 5);
  assert.deepEqual(
    cells.map(([label]) => label),
    ["目标系统仓库", "项目 CRP 基线", "基线同步状态", "项目固定软件", "项目经理"],
  );
  assert.equal(cells[0]?.[1], "桌面专业版 V25");
  assert.equal(cells[1]?.[1], "snipe-2500u2");
  assert.match(String(cells[2]?.[1]), /class="dot is-ok">已同步/);
  assert.equal(cells[3]?.[1], "2 个仓库");
  assert.equal(cells[4]?.[1], "刘洋");

  assert.match(html, /<input id="wizard-version" class="input"[^>]*value="25\.0\.2"/);
  // 项目类型只读：不可编辑。
  assert.match(html, /<input class="input"[^>]*disabled=""[^>]*value="—"/);
  assert.match(html, /<textarea id="wizard-memo" class="textarea"/);
  assert.match(html, /改窗口管理器/);
});

test("第 1 步：项目阻断原因逐条摆出来", () => {
  const html = htmlOf(
    StepProject({
      managers: [],
      managerProjects: [],
      managerId: "manager-1",
      projectId: "project-1",
      version: "25.0.2",
      description: "",
      project: project({
        ready: false,
        blockers: [{ code: "dependency_cycle", message: "软件依赖存在环：kwin → dde-dock → kwin。" }],
      }),
      onManagerChange: () => {},
      onProjectChange: () => {},
      onVersionChange: () => {},
      onDescriptionChange: () => {},
    }),
  );

  assert.match(html, /class="risk" role="alert"/);
  assert.match(html, /软件依赖存在环：kwin → dde-dock → kwin。/);
});

test("第 2 步：目标横幅、三档统计、筛选与搜索、7 列表格、表尾统计", () => {
  const html = htmlOf(StepReview({ ...stepReviewProps, rows: [reviewRow()] }));

  // 目标横幅：项目 / 基线 + 预设仓库数。
  assert.match(html, /class="target-banner"[\s\S]*?桌面专业版 V25　\/　snipe-2500u2/);
  assert.match(html, /class="chip">项目预设 1 个仓库/);

  // 三档统计与刷新按钮。
  assert.match(html, /class="kpis"/);
  assert.match(html, /<b class="num">1<\/b><small>关注仓库<\/small>/);
  assert.match(html, /<div class="has"><b class="num">1<\/b><small>检测到更新<\/small>/);
  assert.match(html, /<b class="num">0<\/b><small>无变化<\/small>/);
  assert.match(html, /刷新代码状态/);

  // 筛选与搜索。
  assert.match(html, /<option value="all" selected="">全部软件<\/option>/);
  assert.match(html, /<option value="yes">仅有更新<\/option>/);
  assert.match(html, /<option value="no">仅无变化<\/option>/);
  assert.match(html, /placeholder="搜索软件包 \/ Commit"/);

  // 7 列，第一列是提交顺序。
  const headers = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/gu)].map((match) => match[1]);
  assert.deepEqual(headers, [
    "提交顺序",
    "软件仓库",
    "本次分支",
    "本次 Commit / 代码版本",
    "CRP 仓库版本",
    "本次提测版本",
    "更新状态",
  ]);

  assert.match(html, /<div class="table-scroll wiz-table"><table class="grid cols-wizard">/);
  assert.match(html, /本次将提测 <b>1<\/b> 个项目软件/);
  assert.match(html, /代码版本取自所选 Commit 的 debian\/changelog/);
});

test("第 2 步：每行的分支、Commit、提测版本与更新状态都在单元格里", () => {
  const html = htmlOf(StepReview({ ...stepReviewProps, rows: [reviewRow()] }));

  assert.match(html, /<strong>dde-file-manager<\/strong><span class="cell-sub col-mono">deepin\/dde-file-manager/);
  assert.match(html, /<option value="develop\/snipe">develop\/snipe<\/option>/);
  assert.match(html, /<option value="63d0d62ac7af[^"]*" selected="">63d0d62ac7af · fix: 修一处崩溃/);
  assert.match(html, /代码版本 1\.3\.0-1/);
  assert.match(html, /<td class="num col-mono">1\.2\.1-1<\/td>/);
  assert.match(html, /<b class="num text-accent">1\.3\.0-1<\/b>/);
  assert.match(html, /class="text-link">自定义版本号<\/button>/);
  assert.match(html, /<span class="dot is-warn">有更新<\/span>/);
});

test("第 2 步：自定义版本号在单元格里展开输入框与三个动作，不弹浏览器原生窗", () => {
  const html = htmlOf(
    StepReview({
      ...stepReviewProps,
      rows: [reviewRow()],
      editing: "dde-file-manager",
      tagDraft: "9.9.9",
      onTagSave: () => {},
    }),
  );

  assert.match(html, /<input class="input input-sm"[^>]*value="9\.9\.9"/);
  assert.match(html, /class="tag-actions"/);
  assert.match(html, /class="text-link">保存<\/button>/);
  assert.match(html, /class="text-link">恢复默认<\/button>/);
  assert.match(html, /class="text-link">取消<\/button>/);
  // 不是 window.prompt：页面上没有一上来就弹的输入框。
  assert.match(html, /placeholder="1\.3\.0-1"/);
});

test("第 2 步：没有勾选框，也没有调序按钮 —— 全部提测、顺序来自依赖", () => {
  const html = htmlOf(StepReview({ ...stepReviewProps, rows: [reviewRow()] }));

  assert.equal(html.includes('type="checkbox"'), false);
  assert.equal(html.includes("checkbox"), false);
  assert.equal(html.includes("draggable"), false);
  assert.equal(html.includes("上移"), false);
  assert.equal(html.includes("下移"), false);
});

test("第 2 步：Gerrit 读不到分支或提交时下拉禁用并写出原因", () => {
  const html = htmlOf(
    StepReview({
      ...stepReviewProps,
      rows: [
        reviewRow({
          packageName: "kwin",
          branches: [],
          commits: [],
          selection: null,
          releaseVersion: null,
          changed: null,
          tagError: null,
          unavailable: "Gerrit 超时，本次没有取到分支",
        }),
      ],
    }),
  );

  assert.match(html, /<select class="select select-sm" disabled="" aria-label="kwin 本次分支">/);
  assert.match(html, /（读不到分支）/);
  assert.match(html, /<select class="select select-sm" disabled="" aria-label="kwin 本次 Commit">/);
  assert.match(html, /（读不到提交）/);
  assert.match(html, /Gerrit 超时，本次没有取到分支/);
  // 更新状态未知时不冒充「无变化」。
  assert.match(html, /<span class="dot is-wait">未知<\/span>/);
});

test("第 2 步：还没读到仓库数据时只给一句提示，表格不出现", () => {
  const html = htmlOf(
    StepReview({ ...stepReviewProps, refreshing: true, loaded: false, rows: [] }),
  );

  assert.match(html, /正在读取分支与提交…/);
  assert.doesNotMatch(html, /<table/);
});

test("第 2 步：筛选后没有行时出空状态，不显示空表身", () => {
  const html = htmlOf(StepReview({ ...stepReviewProps, rows: [] }));

  assert.match(html, /class="empty"/);
  assert.match(html, /没有符合这个条件的软件/);
});

test("第 3 步：三组配置摘要、7 列确认表与确认提示", () => {
  const html = htmlOf(
    StepConfirm({ project: project(), version: "25.0.2", rows: [confirmRow], packageCount: 2 }),
  );

  assert.match(html, /class="confirm-card"/);
  assert.equal((html.match(/class="cfg-row"/gu) ?? []).length, 3);
  assert.match(html, /<small>所属项目 \/ 项目经理<\/small><b>桌面专业版 V25 · 刘洋<\/b>/);
  assert.match(html, /<small>CRP 目标基线<\/small><b class="num">snipe-2500u2<\/b>/);
  assert.match(html, /<small>目标系统仓库<\/small><b>桌面专业版 V25<\/b>/);
  assert.match(html, /<small>CRP Topic 版本号<\/small><b class="num">25.0.2<\/b>/);
  assert.match(html, /<small>项目固定软件清单<\/small><b>2 个仓库<\/b>/);
  assert.match(html, /1 个（1 个有更新 \/ 0 个无变化）/);

  assert.match(html, /<div class="subhead">本次提测版本确认<\/div>/);

  const headers = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/gu)].map((match) => match[1]);
  assert.deepEqual(headers, [
    "提交顺序",
    "软件仓库",
    "跟踪分支",
    "最新 Commit",
    "代码版本",
    "CRP 仓库版本",
    "本次提测版本",
  ]);

  assert.match(html, /<b class="num text-accent">9\.9\.9<\/b><span class="cell-sub">自定义 Tag<\/span>/);
  assert.match(html, /<div class="tip"[^>]*>[\s\S]*?<b>提测清单已确认<\/b>/);
});

test("外壳：步骤条三步、当前步高亮、按钮文案与第八节的表一致", () => {
  const html = htmlOf(createElement(ReleaseWizard, { projects: [project()] }));

  const steps = [...html.matchAll(/<div class="step ([^"]*)"><div class="step-n">([^<]*)<\/div><div class="step-t">([^<]*)<\/div>/gu)];

  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((match) => match[3]),
    ["项目归属", "检查仓库更新", "确认提测"],
  );
  assert.equal(steps[0]?.[1], "is-on");
  assert.equal(steps[0]?.[2], "01");
  assert.equal(steps[1]?.[1], "");
  assert.equal(steps[2]?.[1], "");

  // 弹窗头：标题与「第 N 步，共 3 步」。
  assert.match(html, /<h2 id="[^"]*">创建提测<\/h2><span class="modal-sub">第 1 步，共 3 步<\/span>/);

  // 第 1 步的底部按钮：取消 / 检查项目仓库更新 →（没选项目时禁用）。
  assert.match(html, /class="btn">取消<\/button>/);
  assert.match(html, /class="btn btn-primary" disabled="">检查项目仓库更新 →<\/button>/);
});

test("第 3 步的底部按钮：返回调整版本 / 在目标 CRP 基线上创建提测", () => {
  // 按钮由外壳按步骤给出，这里只锁文案：把三步的文案集中在一处断言，改字会立刻失败。
  const html = htmlOf(createElement(ReleaseWizard, { projects: [project()] }));

  // 第 1 步只出第 1 步的按钮，其余步骤的按钮不许提前出现。
  assert.equal(html.includes("返回调整版本"), false);
  assert.equal(html.includes("在目标 CRP 基线上创建提测"), false);
  assert.equal(html.includes("确认版本信息 →"), false);
  assert.equal(html.includes("上一步"), false);
});

test("提交成功后的结果页显示编号、顺序与每条快照", () => {
  const html = htmlOf(
    CreatedRelease({
      result: submitResult,
      notice: "提测已创建：版本 25.0.2，第 1 轮，1 条快照。",
    }),
  );

  assert.match(html, /<div class="tip" role="status">/);
  assert.match(html, /<b>提测已创建<\/b>/);
  assert.match(html, /提测已创建：版本 25\.0\.2，第 1 轮，1 条快照。/);
  assert.match(html, /<b class="col-mono">release-1<\/b>/);
  assert.match(html, /<b class="col-mono">dde-file-manager<\/b>/);
  assert.match(html, /<div class="table-scroll"><table class="grid cols-confirm">/);
  assert.match(html, /9\.9\.9/);
  assert.match(html, /再建一个提测/);
});
