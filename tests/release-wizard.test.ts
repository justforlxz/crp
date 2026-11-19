/**
 * 创建提测向导拆成子组件后的渲染测试：把外壳与四个子组件渲染成 HTML，对着渲染结果断言。
 *
 * 锁住的是拆分前后必须一字不差的东西：
 *
 * - 三步的文案、表头、逐行内容与按钮禁用条件；
 * - 外壳把状态传给三步的方式（第一步默认展开、第二步第三步按步骤出现、项目经理去重）；
 * - 窄屏溢出的修法：七列宽表都套在 `.table-scroll` 容器里，溢出留在表格自己身上。
 *
 * 不连数据库：三个步骤组件只吃 props，外壳渲染第一步也不需要仓库数据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { CreatedRelease } from "../app/(app)/releases/new/createdRelease";
import { StepConfirm, type ConfirmRow } from "../app/(app)/releases/new/stepConfirm";
import { StepProject } from "../app/(app)/releases/new/stepProject";
import { StepReview, type ReviewRow } from "../app/(app)/releases/new/stepReview";
import { ReleaseWizard } from "../app/(app)/releases/new/wizard";
import type { SubmitResult } from "../app/(app)/releases/new/wizardTypes";
import type { ReleaseProjectChoice } from "../lib/releases";

const SHA = "63d0d62ac7afc3f0b4c5d6e7f8091a2b3c4d5e6f";

/** 把一段子元素渲染成静态 HTML，断言都对着渲染结果做，不对着 React 元素内部结构做。 */
function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function project(overrides: Partial<ReleaseProjectChoice> = {}): ReleaseProjectChoice {
  return {
    id: "project-1",
    key: "desktop-v25",
    name: "桌面专业版 V25",
    managerId: "manager-1",
    managerName: "刘洋",
    baseline: { id: "baseline-1", name: "snipe-2500u2", state: "synced", stateLabel: "已同步" },
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
    repoVersion: "1.2.1-1",
    branches: ["develop/eagle", "develop/snipe"],
    commits: [
      { sha: SHA, summary: "fix: 修一处崩溃", authorName: "刘洋", time: "2026-11-18 10:00:00" },
    ],
    selection: {
      branch: "develop/eagle",
      commitSha: SHA,
      codeVersion: "1.3.0-1",
      customTag: "9.9.9",
    },
    releaseVersion: "9.9.9",
    changed: true,
    tagError: null,
    busy: false,
    ...overrides,
  };
}

const emptyRow: ReviewRow = {
  packageName: "kwin",
  repoPath: "deepin-kde/kwin",
  repoVersion: null,
  branches: [],
  commits: [],
  selection: null,
  releaseVersion: null,
  changed: null,
  tagError: null,
  busy: false,
};

const confirmRow: ConfirmRow = {
  packageName: "dde-file-manager",
  branch: "develop/eagle",
  commitSha: SHA,
  codeVersion: "1.3.0-1",
  repoVersion: "1.2.1-1",
  releaseVersion: "9.9.9",
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

test("第一步显示选项目、版本号与阻断原因，没选项目时不能往下走", () => {
  const html = htmlOf(
    StepProject({
      active: true,
      managers: [["manager-1", "刘洋"]],
      managerProjects: [project()],
      managerId: "manager-1",
      projectId: "",
      version: "",
      description: "",
      project: project(),
      onManagerChange: () => {},
      onProjectChange: () => {},
      onVersionChange: () => {},
      onDescriptionChange: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /<h2 data-style-anchor="release-new.step-project">第一步：项目归属<\/h2>/);
  assert.match(html, /<option value="manager-1"[^>]*>刘洋<\/option>/);
  assert.match(html, /<option value="project-1"[^>]*>桌面专业版 V25（desktop-v25）<\/option>/);
  assert.match(html, /<code>snipe-2500u2<\/code>（已同步）/);
  assert.match(html, /2 个，清单内部依赖 1 条/);
  assert.match(html, /<code>dde-file-manager → kwin<\/code>/);
  assert.match(html, /下一步：检查仓库更新<\/button>/);
  assert.match(html, /<button type="button"[^>]*disabled=""/);
});

test("进入第二步后第一步的输入框仍在，但变为不可编辑，也不再出现下一步按钮", () => {
  const html = htmlOf(
    StepProject({
      active: false,
      managers: [["manager-1", "刘洋"]],
      managerProjects: [project()],
      managerId: "manager-1",
      projectId: "project-1",
      version: "25.0.2",
      description: "",
      project: project(),
      onManagerChange: () => {},
      onProjectChange: () => {},
      onVersionChange: () => {},
      onDescriptionChange: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /id="release-manager"[^>]*disabled=""/);
  assert.match(html, /id="release-version"[^>]*disabled=""/);
  assert.doesNotMatch(html, /下一步：检查仓库更新/);
});

test("项目的阻断原因在第一步逐条摆出来", () => {
  const html = htmlOf(
    StepProject({
      active: true,
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
      onNext: () => {},
    }),
  );

  assert.match(html, /这个项目现在不能提测：/);
  assert.match(html, /软件依赖存在环：kwin → dde-dock → kwin。/);
});

test("第二步的表格逐包列出分支、提交与三个版本号，并说明几号包有更新", () => {
  const html = htmlOf(
    StepReview({
      refreshing: false,
      loaded: true,
      order: ["dde-file-manager", "kwin"],
      blockers: [],
      rows: [reviewRow(), emptyRow],
      packageCount: 2,
      changedCount: 1,
      warnings: [],
      errors: [],
      canGoNext: true,
      onRefresh: () => {},
      onBranchChange: () => {},
      onCommitChange: () => {},
      onTagChange: () => {},
      onBack: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /<h2>第二步：检查仓库更新<\/h2>/);
  assert.match(html, /从 Gerrit 刷新/);
  assert.match(html, /<code>dde-file-manager → kwin<\/code>/);
  assert.match(html, /<th>提测版本（自定义 Tag）<\/th>/);
  assert.match(html, /deepin\/dde-file-manager/);
  assert.match(html, /<option value="develop\/snipe">develop\/snipe<\/option>/);
  assert.match(html, /<option value="63d0d62ac7af/);
  assert.match(html, /1\.3\.0-1/);
  assert.match(html, /1\.2\.1-1/);
  assert.match(html, /<small>提测版本：9\.9\.9<\/small>/);
  assert.match(html, /有更新/);
  // 没有读到分支与提交的包：给出占位、提测版本与「对比上次」都显示破折号。
  assert.match(html, /（读不到分支）/);
  assert.match(html, /（读不到提交）/);
  assert.match(html, /<small>提测版本：—<\/small>/);
  assert.match(html, /本次将提测 2 个软件，其中 1 个有更新。/);
  assert.match(html, /「无变化」的软件包同样会进提测。/);
});

test("第二步的宽表套在横向滚动容器里，窄屏不让整页溢出", () => {
  const html = htmlOf(
    StepReview({
      refreshing: false,
      loaded: true,
      order: ["dde-file-manager"],
      blockers: [],
      rows: [reviewRow()],
      packageCount: 1,
      changedCount: 1,
      warnings: [],
      errors: [],
      canGoNext: true,
      onRefresh: () => {},
      onBranchChange: () => {},
      onCommitChange: () => {},
      onTagChange: () => {},
      onBack: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /<div class="table-scroll"[^>]*><table class="data-table"/);
});

test("第二步还没读到仓库数据时只给一句提示，表格不出现", () => {
  const html = htmlOf(
    StepReview({
      refreshing: true,
      loaded: false,
      order: null,
      blockers: [],
      rows: [],
      packageCount: 0,
      changedCount: 0,
      warnings: [],
      errors: [],
      canGoNext: false,
      onRefresh: () => {},
      onBranchChange: () => {},
      onCommitChange: () => {},
      onTagChange: () => {},
      onBack: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /正在读取分支与提交…/);
  assert.doesNotMatch(html, /<table/);
});

test("阻断、警告、读取失败三种提示分别成块，Tag 格式问题写在对应行里", () => {
  const html = htmlOf(
    StepReview({
      refreshing: false,
      loaded: true,
      order: ["dde-file-manager", "kwin"],
      blockers: [{ code: "baseline_unavailable", message: "基线 snipe-2500u2 还没有同步过。" }],
      rows: [
        reviewRow({ tagError: "自定义 Tag 不合法：不能包含半角连字符 '-'" }),
        emptyRow,
      ],
      packageCount: 2,
      changedCount: 1,
      warnings: [{ packageName: "dde-file-manager", warning: "跟踪分支不存在，暂用 develop/snipe。" }],
      errors: [{ packageName: "kwin", error: "读不到分支。" }],
      canGoNext: false,
      onRefresh: () => {},
      onBranchChange: () => {},
      onCommitChange: () => {},
      onTagChange: () => {},
      onBack: () => {},
      onNext: () => {},
    }),
  );

  assert.match(html, /提交被阻断：/);
  assert.match(html, /基线 snipe-2500u2 还没有同步过。/);
  assert.match(html, /这些软件包的数据可用，但需要看一眼：/);
  assert.match(html, /dde-file-manager：跟踪分支不存在，暂用 develop\/snipe。/);
  assert.match(html, /这些软件包读不到仓库数据：/);
  assert.match(html, /kwin：读不到分支。/);
  assert.match(html, /<small role="alert"> 自定义 Tag 不合法/);
  assert.match(html, /<button type="button"[^>]*disabled="">下一步：确认<\/button>/);
});

test("第三步按投递顺序摆出将要固化的内容，提交中时按钮换成提交中", () => {
  const html = htmlOf(
    StepConfirm({
      rows: [confirmRow],
      submitting: false,
      canSubmit: true,
      onBack: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(html, /<h2>第三步：确认提交<\/h2>/);
  assert.match(html, /<div class="table-scroll"[^>]*><table class="data-table"/);
  assert.match(html, /<th>提测版本<\/th>/);
  assert.match(html, /<td>dde-file-manager<\/td>/);
  assert.match(html, /<code>develop\/eagle<\/code>/);
  assert.match(html, /<code>63d0d62ac7af<\/code>/);
  assert.match(html, /9\.9\.9/);
  assert.match(html, /提交后状态为 <code>pending<\/code>/);

  const submitting = htmlOf(
    StepConfirm({
      rows: [confirmRow],
      submitting: true,
      canSubmit: false,
      onBack: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(submitting, /提交中…/);
  assert.match(submitting, /<button type="button"[^>]*disabled="">提交中…<\/button>/);
});

test("提交成功后的结果页显示编号、顺序与每条快照", () => {
  const html = htmlOf(
    CreatedRelease({
      result: submitResult,
      notice: "提测已创建：版本 25.0.2，第 1 轮，1 条快照。",
    }),
  );

  assert.match(html, /<h2>提测已创建<\/h2>/);
  assert.match(html, /提测已创建：版本 25\.0\.2，第 1 轮，1 条快照。/);
  assert.match(html, /<code>release-1<\/code>/);
  assert.match(html, /<code>dde-file-manager<\/code>/);
  assert.match(html, /<div class="table-scroll"[^>]*><table class="data-table"/);
  assert.match(html, /<td>9\.9\.9<\/td>/);
  assert.match(html, /再建一个提测/);
});

test("向导外壳默认停在第一步，项目经理只出现一次，后面两步不渲染", () => {
  const html = htmlOf(createElement(ReleaseWizard, {
    projects: [
      project(),
      project({ id: "project-2", key: "desktop-v20", name: "桌面专业版 V20", managerId: "manager-2", managerName: "陈浩" }),
      project({ id: "project-3", key: "desktop-v25-extra", name: "桌面专业版 V25 附加" }),
    ],
  }));

  // 页面标题由 PageShell 出（见 app/(app)/releases/new/page.tsx），向导只出内容。
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /三步：选项目 → 检查仓库更新 → 确认提交。/);
  assert.match(html, /<a href="\/projects">返回项目列表<\/a>/);
  assert.match(html, /<h2 data-style-anchor="release-new.step-project">第一步：项目归属<\/h2>/);
  assert.equal(html.match(/<option value="manager-1"[^>]*>刘洋<\/option>/g)?.length, 1);
  assert.equal(html.match(/<option value="manager-2"[^>]*>陈浩<\/option>/g)?.length, 1);
  // 还没选项目经理，项目下拉里没有项目；第二步、第三步都还没出现。
  assert.match(html, /请选择项目经理/);
  assert.doesNotMatch(html, /第二步：检查仓库更新/);
  assert.doesNotMatch(html, /第三步：确认提交/);
});
