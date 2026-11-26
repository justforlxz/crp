/**
 * 项目四 tab 弹窗（MKACG-1010）。
 *
 * 锁住的是「能不能把弹窗搬成原型那个样子、并且把切 tab 的草稿留住」这一层里可以静态断言的部分：
 *
 * - 四个 tab 的名字与顺序、计数只出现在软件包清单与提测记录上（AC1）；
 * - 切 tab 只换 tab，草稿原样带走；改草稿只改点到的字段（AC2）；
 * - 软件包清单能列出、能移除、能从已登记的包里加，并写明「顺序由依赖决定」（AC3）；
 * - 提测记录只拿自己那一组（AC4）；
 * - 危险操作单独一页，说明「只删平台配置，不动 CRP」，删除有二次确认（AC5）；
 * - 删除入口不在别的 tab 上，避免误点（AC7 的「单独一页」）。
 *
 * 「点卡片真的弹出 1120 宽的弹窗」「点 × / 遮罩 / Esc 真的关掉」「点删除真的删掉」要真浏览器，
 * 由验收在页面上点，这里不伪造。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  BasicFields,
  DangerTab,
  ProjectModal,
  ReleasesTab,
  SoftwareTab,
  type ProjectModalProps,
} from "../app/(app)/projects/projectModal";
import {
  baselineChoicesFor,
  draftOf,
  editDraft,
  emptyDraft,
  groupReleasesByProject,
  initialModalState,
  projectTabs,
  switchTab,
  type BaselineChoice,
  type ManagerChoice,
  type PackageChoice,
  type ProjectRelease,
} from "../app/(app)/projects/modalModel";

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/** 数一段 HTML 里某个 class 出现了几次：只数 `class="…"` 里与它逐字相同的 token。 */
function countClass(html: string, name: string): number {
  let total = 0;

  for (const match of html.matchAll(/class="([^"]*)"/gu)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token === name) {
        total += 1;
      }
    }
  }

  return total;
}

const MANAGERS: ManagerChoice[] = [
  { id: "manager-1", name: "林小志" },
  { id: "manager-2", name: "郭垚" },
];

const BASELINES: BaselineChoice[] = [
  { id: "baseline-1", name: "eagle-1072", state: "synced", stateLabel: "已同步" },
  { id: "baseline-2", name: "eagle-1076", state: "syncing", stateLabel: "同步中" },
  { id: "baseline-3", name: "snipe-2500", state: "synced", stateLabel: "已同步" },
];

const PACKAGES: PackageChoice[] = [
  { id: "pkg-1", name: "kwayland", repoPath: "deepin-kde/kwayland", currentVersion: "5.27.10", defaultBranch: "develop/eagle" },
  { id: "pkg-2", name: "kwin", repoPath: "deepin-kde/kwin", currentVersion: "5.27.11", defaultBranch: "develop/eagle" },
  { id: "pkg-3", name: "dde-dock", repoPath: "dde/dde-dock", currentVersion: null, defaultBranch: "master" },
];

const RELEASES: ProjectRelease[] = [
  {
    id: "release-1",
    version: "25.0.3",
    revision: 2,
    status: "success",
    createdByName: "林小志",
    createdAt: new Date("2026-11-24T10:20:00Z"),
  },
];

/** 一个项目：清单里两个包，一条提测。 */
const PROJECT: NonNullable<ProjectModalProps["project"]> = {
  id: "project-1",
  key: "desktop-core",
  name: "桌面核心 V25",
  description: "统信桌面操作系统主线版本",
  manager: { id: "manager-1", name: "林小志" },
  baseline: { id: "baseline-1", name: "eagle-1072" },
  software: {
    count: 2,
    entries: [
      { packageName: "kwayland", trackedBranch: "develop/eagle", lastSubmittedCommit: "abcdef1234567890" },
      { packageName: "kwin", trackedBranch: "develop/eagle", lastSubmittedCommit: null },
    ],
  },
};

/** 弹窗的完整入参；测哪一条就覆盖哪一条。 */
function modalProps(overrides: Partial<ProjectModalProps> = {}): ProjectModalProps {
  return {
    project: PROJECT,
    workspaceId: "workspace-1",
    query: "?workspace=desktop-core",
    managers: MANAGERS,
    baselines: BASELINES,
    packages: PACKAGES,
    releases: RELEASES,
    onClose: () => undefined,
    onNotice: () => undefined,
    onError: () => undefined,
    onChanged: () => undefined,
    ...overrides,
  };
}

test("四个 tab 的名字、顺序与计数：只有软件包清单与提测记录带数字", () => {
  assert.deepEqual(projectTabs({ softwareCount: 3, releaseCount: 2 }), [
    { key: "basic", label: "基本信息" },
    { key: "software", label: "软件包清单", count: 3 },
    { key: "releases", label: "提测记录", count: 2 },
    { key: "danger", label: "危险操作" },
  ]);

  // 0 也要显示成 0，不能当成「没有计数」隐藏掉。
  const empty = projectTabs({ softwareCount: 0, releaseCount: 0 });
  assert.equal(empty[1]?.count, 0);
  assert.equal(empty[2]?.count, 0);
  assert.equal(empty[0]?.count, undefined);
  assert.equal(empty[3]?.count, undefined);
});

test("编辑时草稿取项目现值，新建时名称与标识留空", () => {
  assert.deepEqual(draftOf(PROJECT), {
    name: "桌面核心 V25",
    key: "desktop-core",
    projectManagerId: "manager-1",
    baselineId: "baseline-1",
    description: "统信桌面操作系统主线版本",
  });

  assert.deepEqual(emptyDraft(MANAGERS, BASELINES), {
    name: "",
    key: "",
    projectManagerId: "manager-1",
    baselineId: "baseline-1",
    description: "",
  });
});

test("新建时默认基线取第一条已同步的，不是列表第一条", () => {
  // 基线按名称排序，第一条正好没同步是常态（评审确认过的缺陷：默认选中它，一保存就被服务端拒绝）。
  const unsyncedFirst: BaselineChoice[] = [
    { id: "baseline-a", name: "eagle-1071", state: "unsynced", stateLabel: "未同步" },
    { id: "baseline-b", name: "eagle-1072", state: "synced", stateLabel: "已同步" },
    { id: "baseline-c", name: "eagle-1076", state: "synced", stateLabel: "已同步" },
  ];

  assert.equal(emptyDraft(MANAGERS, unsyncedFirst).baselineId, "baseline-b");

  // 一条都没同步时留空串：不塞一个一定会被服务端挡下的默认值。
  const noneSynced = unsyncedFirst.filter((baseline) => baseline.state !== "synced");
  assert.equal(emptyDraft(MANAGERS, noneSynced).baselineId, "");
});

test("可选基线只放已同步的，加上项目当前绑定的那一条", () => {
  assert.deepEqual(
    baselineChoicesFor(BASELINES, "baseline-1").map((baseline) => baseline.id),
    ["baseline-1", "baseline-3"],
  );
  // 当前绑定正好没同步：仍然要出现在下拉里，否则一保存就被悄悄换成别的基线。
  assert.deepEqual(
    baselineChoicesFor(BASELINES, "baseline-2").map((baseline) => baseline.id),
    ["baseline-1", "baseline-2", "baseline-3"],
  );
  // 新建时没有当前绑定，只给已同步的。
  assert.deepEqual(
    baselineChoicesFor(BASELINES, "").map((baseline) => baseline.id),
    ["baseline-1", "baseline-3"],
  );
});

test("切 tab 不丢输入：改过的名称与经理切走再切回都还在", () => {
  const start = initialModalState(PROJECT, MANAGERS, BASELINES);
  const edited = editDraft(start, { name: "桌面核心 V25 R2", projectManagerId: "manager-2" });

  const away = switchTab(edited, "software");
  assert.equal(away.tab, "software");
  assert.deepEqual(away.draft, edited.draft);

  const back = switchTab(away, "basic");
  assert.equal(back.tab, "basic");
  assert.equal(back.draft.name, "桌面核心 V25 R2");
  assert.equal(back.draft.projectManagerId, "manager-2");

  // 草稿态不写库：切 tab 只动 tab，别的字段一个都不许变。
  assert.deepEqual(
    { ...back.draft, name: edited.draft.name, projectManagerId: edited.draft.projectManagerId },
    edited.draft,
  );
});

test("改草稿只改点到的字段，tab 不动", () => {
  const state = switchTab(initialModalState(PROJECT, MANAGERS, BASELINES), "releases");
  const next = editDraft(state, { description: "换一段说明" });

  assert.equal(next.tab, "releases");
  assert.equal(next.draft.description, "换一段说明");
  assert.equal(next.draft.name, PROJECT.name);
  assert.equal(next.draft.baselineId, "baseline-1");
});

test("弹窗打开时是宽版，四个 tab 齐备，停在基本信息", () => {
  const html = htmlOf(createElement(ProjectModal, modalProps()));

  // 宽版 1120（原型 `.modal.is-wide`），头部带项目名与标识。
  assert.match(html, /class="modal is-wide"/u);
  assert.match(html, /<h2>桌面核心 V25<\/h2><span class="modal-sub">desktop-core<\/span>/u);

  assert.equal(countClass(html, "tabs"), 1);
  assert.equal(countClass(html, "tab"), 4);
  assert.equal(countClass(html, "tab-n"), 2);

  // 默认停在基本信息：只有它带 aria-selected="true"。
  const selected = [...html.matchAll(/<button type="button" class="tab" role="tab" aria-selected="(true|false)"/gu)]
    .filter((match) => match[1] === "true");
  assert.equal(selected.length, 1);
  assert.match(html, /aria-selected="true">基本信息</u);

  // 基本信息 tab 的五个字段都在，名称有值，标识是只读的。
  assert.equal(countClass(html, "input"), 2);
  assert.equal(countClass(html, "select"), 2);
  assert.equal(countClass(html, "textarea"), 1);
  assert.match(html, /value="桌面核心 V25"/u);
  assert.match(html, /disabled="" value="desktop-core"/u);
});

test("危险操作 tab 之外不出现删除入口", () => {
  const html = htmlOf(createElement(ProjectModal, modalProps()));

  // 删除只在危险操作 tab 里；基本信息的底部是「取消 + 保存」。
  assert.equal(countClass(html, "btn-danger"), 0);
  assert.doesNotMatch(html, /删除这个项目/u);
  assert.match(html, /<button type="button" class="btn btn-primary">保存<\/button>/u);
});

test("新建项目的弹窗没有标识锁定，底部是「创建项目」", () => {
  const html = htmlOf(createElement(ProjectModal, modalProps({ project: null, releases: [] })));

  assert.match(html, /<h2>新建项目<\/h2><span class="modal-sub">项目边界就是提测边界<\/span>/u);
  assert.match(html, /class="input" placeholder="desktop-core" value=""/u);
  assert.doesNotMatch(html, /disabled="" value="desktop-core"/u);
  assert.match(html, /创建项目<\/button>/u);
  // 计数为 0 也照常显示。
  assert.equal(countClass(html, "tab-n"), 2);
});

test("基本信息：编辑时标识只读，名称、经理、基线、说明都可改", () => {
  const editing = htmlOf(
    createElement(BasicFields, {
      draft: draftOf(PROJECT),
      isNew: false,
      managers: MANAGERS,
      baselines: baselineChoicesFor(BASELINES, "baseline-1"),
      onChange: () => undefined,
    }),
  );

  assert.match(editing, /disabled="" value="desktop-core"/u);
  assert.match(editing, /标识创建后不能改/u);
  assert.match(editing, /<option value="manager-1" selected="">林小志<\/option>/u);
  // 已同步的基线不带括注；它自己就是当前值时也一样。
  assert.match(editing, /<option value="baseline-1" selected="">eagle-1072<\/option>/u);

  // 当前绑定的基线正好没同步时，它留在下拉里并带上状态括注 —— 否则看不到当前值，
  // 一保存就被悄悄换成别的基线。
  const boundToUnsynced = htmlOf(
    createElement(BasicFields, {
      draft: { ...draftOf(PROJECT), baselineId: "baseline-2" },
      isNew: false,
      managers: MANAGERS,
      baselines: baselineChoicesFor(BASELINES, "baseline-2"),
      onChange: () => undefined,
    }),
  );

  assert.match(
    boundToUnsynced,
    /<option value="baseline-2" selected="">eagle-1076（同步中）<\/option>/u,
  );

  const creating = htmlOf(
    createElement(BasicFields, {
      draft: emptyDraft(MANAGERS, BASELINES),
      isNew: true,
      managers: MANAGERS,
      baselines: baselineChoicesFor(BASELINES, ""),
      onChange: () => undefined,
    }),
  );

  assert.doesNotMatch(creating, /disabled=""/u);
  assert.doesNotMatch(creating, /标识创建后不能改/u);
});

test("软件包清单：按依赖顺序列出、能移除、能加，并写明顺序由依赖决定", () => {
  const html = htmlOf(
    createElement(SoftwareTab, {
      isNew: false,
      entries: PROJECT.software.entries,
      packageByName: new Map(PACKAGES.map((item) => [item.name, item])),
      candidates: PACKAGES.filter((item) => item.name === "dde-dock"),
      addableId: "pkg-3",
      pending: false,
      onPick: () => undefined,
      onAdd: () => undefined,
      onRemove: () => undefined,
    }),
  );

  assert.equal(countClass(html, "pick-list"), 1);
  assert.equal(countClass(html, "pick"), 2);
  // 顺序号取清单顺序（依赖排出来的那个），不是添加顺序。
  assert.match(html, /<span class="step-n num">1<\/span><span><span class="pick-t">kwayland<\/span>/u);
  assert.match(html, /<span class="step-n num">2<\/span><span><span class="pick-t">kwin<\/span>/u);
  assert.match(html, /develop\/eagle · 当前版本 5\.27\.10 · 上次提测 abcdef123456/u);
  assert.match(html, /develop\/eagle · 当前版本 5\.27\.11 · 未提测/u);
  assert.equal(countClass(html, "btn-danger"), 2);
  assert.match(html, /顺序由软件包依赖决定，不按添加顺序。/u);
  // 下拉里只剩还没进清单的包。
  assert.match(html, /<option value="pkg-3" selected="">dde-dock · master<\/option>/u);
  assert.doesNotMatch(html, /全选|勾选/u);
});

test("软件包清单为空时给空态，新建项目提示先保存", () => {
  const empty = htmlOf(
    createElement(SoftwareTab, {
      isNew: false,
      entries: [],
      packageByName: new Map(),
      candidates: PACKAGES,
      addableId: "pkg-1",
      pending: false,
      onPick: () => undefined,
      onAdd: () => undefined,
      onRemove: () => undefined,
    }),
  );

  assert.equal(countClass(empty, "empty"), 1);
  assert.match(empty, /这个项目还没有软件包/u);

  const fresh = htmlOf(
    createElement(SoftwareTab, {
      isNew: true,
      entries: [],
      packageByName: new Map(),
      candidates: PACKAGES,
      addableId: "pkg-1",
      pending: false,
      onPick: () => undefined,
      onAdd: () => undefined,
      onRemove: () => undefined,
    }),
  );

  assert.match(fresh, /新建的项目还没有软件包/u);
  assert.doesNotMatch(fresh, /加入清单/u);
});

test("提测记录：只列传进来的那一组，点版本号进详情", () => {
  const html = htmlOf(createElement(ReleasesTab, { releases: RELEASES, query: "?workspace=desktop-core" }));

  assert.equal(countClass(html, "grid"), 1);
  assert.equal(countClass(html, "is-clickable"), 1);
  assert.match(html, /<a href="\/releases\/release-1\?workspace=desktop-core"><strong>25\.0\.3<\/strong><\/a>/u);
  assert.match(html, /第 2 轮/u);
  assert.match(html, /class="dot is-ok">成功/u);
  assert.match(html, /2026-11-24 10:20 UTC/u);
  assert.match(html, /这里只列这个项目的提测/u);

  const empty = htmlOf(createElement(ReleasesTab, { releases: [], query: "" }));
  assert.equal(countClass(empty, "empty"), 1);
  assert.match(empty, /这个项目还没有提测/u);
});

test("提测记录按项目分组：每一组只有自己的提测", () => {
  const grouped = groupReleasesByProject([
    { ...RELEASES[0]!, id: "release-1", projectId: "project-1" },
    { ...RELEASES[0]!, id: "release-2", projectId: "project-2" },
    { ...RELEASES[0]!, id: "release-3", projectId: "project-1" },
  ]);

  assert.deepEqual(Object.keys(grouped).sort(), ["project-1", "project-2"]);
  assert.deepEqual(grouped["project-1"]?.map((row) => row.id), ["release-1", "release-3"]);
  assert.deepEqual(grouped["project-2"]?.map((row) => row.id), ["release-2"]);
  // `projectId` 只用于分组，不进结果。
  assert.deepEqual(Object.keys(grouped["project-1"]?.[0] ?? {}).sort(), [
    "createdAt",
    "createdByName",
    "id",
    "revision",
    "status",
    "version",
  ]);
});

test("危险操作页先讲清只删平台配置，再给删除按钮", () => {
  const html = htmlOf(createElement(DangerTab, { isNew: false, onDelete: () => undefined }));

  assert.equal(countClass(html, "risk"), 1);
  assert.match(html, /只删平台里的项目配置与软件清单，<b>不动 CRP 上的任何东西<\/b>/u);
  assert.equal(countClass(html, "btn-danger"), 1);
  assert.match(html, /删除这个项目/u);

  const fresh = htmlOf(createElement(DangerTab, { isNew: true, onDelete: () => undefined }));
  assert.match(fresh, /新建的项目还不能删除/u);
  assert.equal(countClass(fresh, "btn-danger"), 0);
});
