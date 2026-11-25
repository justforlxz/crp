/**
 * 构建队列页的正文块（MKACG-987）。
 *
 * 锁住的是「v2 模块齐了、结构没有降级」这一层可验证的部分：
 *
 * - 依赖流每条一行：`.dep-n` 的个数与 `.dep-row` 一样多，序号在上游说明左边，不是表格行；
 * - 构建作业每条一行：`.qi-ico`、`.qi-bar`、`.qi-pct` 的个数都与 `.queue-item` 一样多，
 *   `.qi-name` 里同时有软件包名（`<b>`）与版本（`<small class="num">`）；
 * - `.dep-name` 与 `.dep-note` 在同一个容器里，说明跟在名字后面；
 * - 四张统计卡各带一个 `.stat-ico`，数字取视图里的真实值；
 * - 调度事件是 `table.grid`，时间列挂 `.num col-mono`；
 * - 空数据、没有作业的包、投递失败三档降级都还能渲染。
 *
 * 「页面上有没有横向溢出」要真浏览器量，由验收在页面上确认，不在这里伪造。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { QueueBoard } from "../app/(app)/queue/board";
import type {
  BuildQueueView,
  QueueReleaseView,
  QueueTaskRow,
} from "../lib/build";

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/** 数一段 HTML 里出现了几次某个 class：只数 `class="…"` 里与它逐字相同的 token。 */
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

/** 一段 HTML 的元素里有没有这个标签。 */
function hasTag(html: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s>]`, "u").test(html);
}

/** 一个队列任务，默认是「等待依赖」；测哪一项就覆盖哪一项。 */
function task(overrides: Partial<QueueTaskRow> & { packageName: string }): QueueTaskRow {
  const { packageName, ...rest } = overrides;

  return {
    releaseId: "release-1",
    releaseVersion: "25.0.3",
    snapshotId: `snapshot-${packageName}`,
    packageName,
    phase: "waiting",
    stage: "等待依赖",
    progress: null,
    progressPercent: null,
    durationMs: null,
    waitingFor: [],
    reason: null,
    dispatchFailure: null,
    ...rest,
  };
}

/** 一条提测，默认只有一条「上游 → 下游」的边。 */
function release(overrides: Partial<QueueReleaseView> = {}): QueueReleaseView {
  return {
    releaseId: "release-1",
    version: "25.0.3",
    projectName: "窗口管理 V25",
    status: "building",
    statusLabel: "构建中",
    workProgress: null,
    workProgressLabel: null,
    workProgressSyncedAt: null,
    edges: [],
    order: [],
    cycle: null,
    tasks: [],
    ...overrides,
  };
}

/** 一份队列视图，默认没有提测与事件。 */
function view(overrides: Partial<BuildQueueView> = {}): BuildQueueView {
  return {
    stats: { queued: 0, building: 0, waiting: 0, finishedToday: 0 },
    releases: [],
    events: [],
    generatedAt: new Date("2026-11-24T14:32:08Z"),
    ...overrides,
  };
}

/** 一份三条任务的提测：上游已完成、下游等待、另一个在构建。 */
function chainedView(): BuildQueueView {
  const tasks = [
    task({ packageName: "kwin", phase: "success", stage: "成功" }),
    task({
      packageName: "dde-dock",
      waitingFor: ["kwin"],
      dispatchFailure: { kind: "rate_limited", reason: "CrpRateLimitedError" },
    }),
    task({
      packageName: "dde-kwin-effects",
      phase: "running",
      stage: "构建中",
      progress: "3/6 个架构完成",
      progressPercent: 50,
      durationMs: 42 * 60_000,
    }),
  ];

  return view({
    stats: { queued: 3, building: 1, waiting: 1, finishedToday: 7 },
    releases: [
      release({
        tasks,
        edges: [
          { from: "kwin", to: "dde-dock" },
          { from: "kwin", to: "dde-kwin-effects" },
        ],
        order: ["kwin", "dde-dock", "dde-kwin-effects"],
      }),
    ],
  });
}

test("AC2/AC3 依赖流一条一行：序号、名字、上游说明、状态点都在，且不是表格", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.equal(countClass(html, "dep-row"), 3);
  assert.equal(countClass(html, "dep-n"), 3, "每一行都要有序号节点");
  assert.equal(countClass(html, "dep-name"), 3);
  assert.equal(countClass(html, "dep-note"), 3);

  // 序号在上游说明左边：`.dep-n` 先出现。
  assert.match(
    html,
    /<div class="dep-n num" aria-hidden="true">1<\/div><div><div class="dep-name">kwin<\/div><div class="dep-note">/u,
  );

  // 依赖流整段里没有表格：`.dep-row` 不能降级成表格行。
  const deps = html.slice(
    html.indexOf('data-style-anchor="queue.topo"'),
    html.indexOf('data-style-anchor="queue.task-list"'),
  );
  assert.ok(deps.length > 0, "依赖面板没渲染出来");
  assert.equal(hasTag(deps, "table"), false, "依赖流不能写成表格");
  assert.equal(hasTag(deps, "tr"), false, "依赖流不能写成表格行");

  // 每行都有状态点：状态不能只靠颜色，色点旁边要带文字。
  // 依赖行的状态点固定写成 `.dep-row` 第三格里的 `<div><span class="dot …">`，
  // 提测标题里那个状态点不在这一格里，所以只数这一种写法。
  const depDots = (deps.match(/<div><span class="dot /gu) ?? []).length;
  assert.equal(depDots, countClass(html, "dep-row"), "每一行都要有状态点");
});

test("AC2 构建作业一条一行：图标、进度条、百分比数量与行数一致", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.equal(countClass(html, "queue-item"), 3);
  assert.equal(countClass(html, "qi-ico"), 3, "每一行都要有图标位");
  assert.equal(countClass(html, "queue-info"), 3);
  assert.equal(countClass(html, "qi-bar"), 3, "没有进度的包也要有进度条位置");
  assert.equal(countClass(html, "qi-pct"), 3);
  assert.equal(countClass(html, "qi-meta"), 3);
});

test("AC3 作业名里同时有软件包名与版本：<b> + <small class=\"num\">", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(html, /<div class="qi-name"><b>kwin<\/b><small class="num">25\.0\.3<\/small><\/div>/u);
  assert.equal(countClass(html, "qi-name"), 3);
});

test("AC3 依赖说明在软件包名之后、同一个容器里", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(
    html,
    /<div class="dep-name">dde-dock<\/div><div class="dep-note">上游 kwin 未完成<\/div>/u,
  );
  assert.match(
    html,
    /<div class="dep-name">kwin<\/div><div class="dep-note">无上游依赖，直接投递<\/div>/u,
  );
});

test("依赖行的状态色按阶段挂 is-done / is-fail / is-wait", () => {
  const html = htmlOf(
    createElement(QueueBoard, {
      workspaceSlug: "system-apps",
      view: view({
        releases: [
          release({
            tasks: [
              task({ packageName: "a", phase: "success", stage: "成功" }),
              task({ packageName: "b", phase: "failed", stage: "失败", reason: "编译失败" }),
              task({ packageName: "c", phase: "waiting", stage: "等待依赖" }),
            ],
            order: ["a", "b", "c"],
          }),
        ],
      }),
    }),
  );

  assert.equal(countClass(html, "is-done"), 1);
  assert.equal(countClass(html, "is-fail"), 1);
  assert.equal(countClass(html, "is-wait") >= 1, true);
});

test("四张统计卡各带图标，数字取视图里的真实值", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.equal(countClass(html, "stat"), 4);
  assert.equal(countClass(html, "stat-ico"), 4);
  assert.equal(countClass(html, "stat-main"), 4);

  for (const [label, value] of [
    ["队列任务", "3"],
    ["正在构建", "1"],
    ["等待依赖", "1"],
    ["今日已完成", "7"],
  ] as const) {
    const wanted = new RegExp(
      `<div class="stat-label">${label}</div><div class="stat-value num">${value}</div>`,
      "u",
    );
    assert.match(html, wanted, `${label}的数字应该来自视图`);
  }
});

test("限流那条不是失败：作业说明里给「等待限流」色点，不写失败原因", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(html, /<span class="dot is-warn">等待限流<\/span>/u);
  assert.equal(html.includes("CrpRateLimitedError"), false, "错误原文留在服务端日志，不上页面");
});

test("没有进度的包也画进度条：value 为 0，百分比写「—」", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(html, /<progress value="0" max="100" aria-label="kwin 构建进度"><\/progress>/u);
  assert.match(html, /<span class="qi-pct num">—<\/span>/u);
  assert.match(html, /<span class="qi-pct num">50%<\/span>/u);
});

test("耗时与状态分两行：<b> 耗时，<small> 状态词", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(
    html,
    /<div class="qi-meta"><b>42 分钟<\/b><small>构建中<\/small><\/div>/u,
  );
  // 架构进度在说明行里，与原型一致（原型：「6 个架构 · amd64、arm64 已完成」）。
  assert.match(html, /窗口管理 V25 · 3\/6 个架构完成/u);
});

test("调度事件是 table.grid，时间列挂 num col-mono", () => {
  const html = htmlOf(
    createElement(QueueBoard, {
      workspaceSlug: "system-apps",
      view: view({
        events: [
          {
            id: "event-1",
            releaseId: "release-1",
            snapshotId: null,
            packageName: "kwin",
            event: "status",
            condition: "快照状态变化",
            result: "构建中 → 成功",
            releaseVersion: "25.0.3",
            createdAt: new Date("2026-11-24T14:32:08Z"),
          },
        ],
      }),
    }),
  );

  assert.match(html, /<table class="grid">/u);
  assert.match(html, /<th class="num">时间<\/th>/u);
  assert.match(
    html,
    /<td class="num col-mono">2026-11-24 14:32:08 UTC<\/td>/u,
  );
  assert.equal(countClass(html, "col-mono"), 1);
});

test("提示块只有一条，说的是限流等待而不是失败", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.equal(countClass(html, "tip"), 1);
  assert.match(html, /限流时会等/u);
  assert.match(html, /等待限流/u);
});

test("没有未完结提测时给空状态，不留空壳", () => {
  const html = htmlOf(createElement(QueueBoard, { view: view(), workspaceSlug: "system-apps" }));

  assert.equal(countClass(html, "dep-row"), 0);
  assert.equal(countClass(html, "queue-item"), 0);
  assert.equal(countClass(html, "empty") >= 2, true, "依赖流与作业列表各有一个空状态");
  assert.match(html, /当前没有未完结的提测/u);
});

test("多条提测各有一段依赖流，版本提示指出最新那条", () => {
  const html = htmlOf(
    createElement(QueueBoard, {
      workspaceSlug: "system-apps",
      view: view({
        releases: [
          release({ releaseId: "release-2", version: "25.0.4", tasks: [task({ packageName: "kwin" })], order: ["kwin"] }),
          release({
            releaseId: "release-1",
            version: "25.0.3",
            projectName: "桌面核心 V25",
            tasks: [task({ packageName: "wayland" })],
            order: ["wayland"],
          }),
        ],
      }),
    }),
  );

  assert.equal(countClass(html, "dep-flow"), 2);
  assert.equal(countClass(html, "queue-item"), 2);
  assert.match(html, /最新：窗口管理 V25 \/ 25\.0\.4，共 2 条/u);
});

test("重排按钮留在当前工作区，且不挂轮询动作", () => {
  const html = htmlOf(createElement(QueueBoard, { view: chainedView(), workspaceSlug: "system-apps" }));

  assert.match(html, /class="btn btn-sm"[^>]*href="\/queue\?workspace=system-apps"/u);
  assert.equal(html.includes("<form"), false, "重排不能提交轮询表单：那会真的向 CRP 投递");
});
