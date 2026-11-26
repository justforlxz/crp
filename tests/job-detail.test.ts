/**
 * 队列作业详情与依赖说明弹窗（MKACG-1012）。
 *
 * 锁住的是「弹窗里到底有没有真东西」这一层可验证的部分：
 *
 * - 四格概要：状态、架构进度、已用时间、CRP Topic —— 进度用的是**传进来的真实架构数**，
 *   不是原型里写死的 6；
 * - 每个架构一行：行数等于这个包的架构作业数，行里有架构名、状态点（带文字）与说明；
 * - 重投按钮：构建中禁用并写明原因，真的失败才可点，被上游阻断的不单独重投；
 * - 依赖说明：上游是谁、当前状态、排序依据、为什么不能手动提前；
 * - 队列条目与依赖节点是**可点的**：`role="button"` + 键盘可达，初始不渲染弹窗。
 *
 * 「点下去真的开出来」要真浏览器，由验收在页面上点，不在这里伪造。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

import {
  DepDetailModal,
  DepQueueRow,
  JobDetailModal,
  JobQueueItem,
  retryStateOf,
} from "../components/job-detail";
import type { QueueTaskRow } from "../lib/build";

/** 弹窗里的重投按钮会用 `useRouter().refresh()`；服务端渲染时给它一个不动的路由器。 */
const ROUTER: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: ROUTER }, node));
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

/** 一个队列任务，默认是「等待依赖」；测哪一项就覆盖哪一项。 */
function task(overrides: Partial<QueueTaskRow> = {}): QueueTaskRow {
  return {
    releaseId: "release-1",
    releaseVersion: "25.0.3",
    snapshotId: "snapshot-kwin",
    packageName: "kwin",
    phase: "waiting",
    stage: "等待依赖",
    progress: null,
    progressPercent: null,
    durationMs: null,
    waitingFor: [],
    reason: null,
    dispatchFailure: null,
    arches: [],
    archProgress: null,
    blockedBy: null,
    topicId: null,
    ...overrides,
  };
}

test("AC2 架构进度用真实架构数：3/6 与 1/4 都来自数据，不是写死的 6", () => {
  const six = htmlOf(
    createElement(JobDetailModal, {
      job: task({
        phase: "running",
        stage: "构建中",
        archProgress: { done: 3, total: 6 },
        arches: [
          { arch: "amd64", status: "success" },
          { arch: "arm64", status: "building" },
          { arch: "mips64el", status: "pending" },
          { arch: "loongarch64", status: "pending" },
          { arch: "sw_64", status: "pending" },
          { arch: "riscv64", status: "pending" },
        ],
      }),
      onClose: () => undefined,
    }),
  );

  assert.match(six, /<dt>架构进度<\/dt><dd><span class="num">3\/6<\/span><\/dd>/u);

  const four = htmlOf(
    createElement(JobDetailModal, {
      job: task({
        phase: "failed",
        stage: "失败",
        archProgress: { done: 1, total: 4 },
        arches: [
          { arch: "amd64", status: "success" },
          { arch: "arm64", status: "failed" },
          { arch: "mips64el", status: "pending" },
          { arch: "loongarch64", status: "pending" },
        ],
      }),
      onClose: () => undefined,
    }),
  );

  assert.match(four, /<dt>架构进度<\/dt><dd><span class="num">1\/4<\/span><\/dd>/u);
});

test("AC1 每个架构一行：行数等于这个包的架构数，行里有架构名、状态点与说明", () => {
  const html = htmlOf(
    createElement(JobDetailModal, {
      job: task({
        phase: "running",
        stage: "构建中",
        durationMs: 42 * 60_000,
        topicId: "29254",
        archProgress: { done: 1, total: 3 },
        arches: [
          { arch: "amd64", status: "success" },
          { arch: "arm64", status: "building" },
          { arch: "mips64el", status: "pending" },
        ],
      }),
      onClose: () => undefined,
    }),
  );

  assert.equal(countClass(html, "col-mono"), 3, "架构名各一格");
  assert.match(html, /<td class="col-mono">amd64<\/td><td><span class="dot is-ok">成功<\/span><\/td>/u);
  assert.match(
    html,
    /<td class="col-mono">arm64<\/td><td><span class="dot is-run">构建中<\/span><\/td><td class="muted">正在编译<\/td>/u,
  );
  assert.match(html, /<td class="muted">排队中<\/td>/u);

  // 四格概要的另外三格：状态、已用时间、Topic 都来自这一行。
  assert.match(html, /<dt>状态<\/dt><dd><span class="dot is-run">构建中<\/span><\/dd>/u);
  assert.match(html, /<dt>已用时间<\/dt><dd><span class="num">42 分钟<\/span><\/dd>/u);
  assert.match(html, /<dt>CRP Topic<\/dt><dd><span class="num">#29254<\/span><\/dd>/u);
  assert.equal(countClass(html, "summary-cell"), 4, "概要固定四格");
});

test("AC3 构建中的作业：重投按钮禁用，并写明原因", () => {
  const html = htmlOf(
    createElement(JobDetailModal, {
      job: task({ phase: "running", stage: "构建中" }),
      onClose: () => undefined,
    }),
  );

  assert.match(html, /<button type="button" class="btn btn-primary" disabled="">重新投递这个包<\/button>/u);
  assert.ok(html.includes("这个包正在构建，构建中的作业不能重投。"), "禁用原因必须写在页面上");
});

test("真的失败才可点重投；被上游阻断、已成功、还没投递都禁用", () => {
  assert.deepEqual(retryStateOf({ phase: "failed", blockedBy: null }), {
    enabled: true,
    reason: null,
  });

  const blocked = retryStateOf({ phase: "failed", blockedBy: "kwin" });
  assert.equal(blocked.enabled, false);
  assert.match(blocked.reason ?? "", /上游 kwin 失败阻断/u);

  assert.equal(retryStateOf({ phase: "success", blockedBy: null }).enabled, false);
  assert.equal(retryStateOf({ phase: "running", blockedBy: null }).enabled, false);
  assert.equal(retryStateOf({ phase: "queued", blockedBy: null }).enabled, false);
  assert.equal(retryStateOf({ phase: "waiting", blockedBy: null }).enabled, false);
});

test("失败的作业可以点重投：按钮不带 disabled", () => {
  const html = htmlOf(
    createElement(JobDetailModal, {
      job: task({ phase: "failed", stage: "失败", reason: "arm64 编译失败" }),
      onClose: () => undefined,
    }),
  );

  assert.match(html, /<button type="button" class="btn btn-primary">重新投递这个包<\/button>/u);
  // 失败原因进说明，不只在提示里。
  assert.ok(html.includes("arm64 编译失败"));
});

test("还没有架构作业时说清原因：没投递、被阻断、没建 Topic 三种不能混成一句", () => {
  const notDispatched = htmlOf(
    createElement(JobDetailModal, {
      job: task({ topicId: "29254" }),
      onClose: () => undefined,
    }),
  );
  assert.match(notDispatched, /这个包还没有投递，投出去之后才会创建架构作业。/u);
  // React 19 把 `colSpan` 原样输出成属性名（不是 `colspan`），断言按真实输出写。
  assert.match(notDispatched, /<td colSpan="3" class="muted">/u);
  assert.match(notDispatched, /<dt>架构进度<\/dt><dd><span class="num">—<\/span><\/dd>/u);

  const blocked = htmlOf(
    createElement(JobDetailModal, {
      job: task({ phase: "failed", stage: "已阻断（上游 kwin 失败）", blockedBy: "kwin" }),
      onClose: () => undefined,
    }),
  );
  assert.match(blocked, /上游 kwin 失败，这个包被阻断，不会创建构建作业。/u);

  const noTopic = htmlOf(
    createElement(JobDetailModal, { job: task(), onClose: () => undefined }),
  );
  assert.match(noTopic, /这次提测还没建 CRP Topic，投递之后才会创建架构作业。/u);
  assert.match(noTopic, /<dt>CRP Topic<\/dt><dd><span class="num">还没建<\/span><\/dd>/u);
});

test("AC4 依赖说明：上游是谁、当前状态、排序依据、为什么不能手动提前", () => {
  const html = htmlOf(
    createElement(DepDetailModal, {
      packageName: "dde-dock",
      position: 2,
      upstreams: ["kwin"],
      stage: "等待依赖",
      phase: "waiting",
      note: "上游 kwin 未完成",
      onClose: () => undefined,
    }),
  );

  assert.match(html, /<h2[^>]*>dde-dock<\/h2><span class="modal-sub">第 2 位<\/span>/u);
  assert.equal(countClass(html, "cfg-row"), 2, "两组配置行");
  assert.match(html, /<small>上游依赖<\/small><b>kwin<\/b>/u);
  assert.match(html, /<small>当前状态<\/small><b><span class="dot is-wait">等待依赖<\/span><\/b>/u);
  assert.match(html, /<small>排序依据<\/small><b>软件包登记里配的依赖关系<\/b>/u);
  assert.match(html, /<small>能不能手动提前<\/small><b>不能，用户改不了顺序<\/b>/u);
  assert.ok(html.includes("上游 kwin 未完成"));
});

test("没有上游的包写「无，可以直接投递」，不写一个空值", () => {
  const html = htmlOf(
    createElement(DepDetailModal, {
      packageName: "kwin",
      position: 1,
      upstreams: [],
      stage: "成功",
      phase: "success",
      note: "无上游依赖，直接投递",
      onClose: () => undefined,
    }),
  );

  assert.match(html, /<small>上游依赖<\/small><b>无，可以直接投递<\/b>/u);
});

test("队列条目可点：role=button、键盘可达、初始不渲染弹窗", () => {
  const html = htmlOf(
    createElement(
      JobQueueItem,
      {
        job: task({ packageName: "kwin" }),
        className: "queue-item is-clickable",
      },
      createElement("div", { className: "qi-name" }, "kwin"),
    ),
  );

  assert.match(
    html,
    /<div class="queue-item is-clickable" role="button" tabindex="0" title="查看 kwin 的作业详情">/u,
  );
  assert.equal(countClass(html, "modal"), 0, "没点之前不该挂一个空弹窗");
  assert.equal(countClass(html, "scrim"), 0);
});

test("依赖节点可点：档位仍按阶段挂在 .dep-row 上", () => {
  const html = htmlOf(
    createElement(
      DepQueueRow,
      {
        packageName: "kwin",
        position: 1,
        upstreams: [],
        stage: "成功",
        phase: "success",
        note: "无上游依赖，直接投递",
        className: "dep-row is-done",
      },
      createElement("div", { className: "dep-n num" }, "1"),
    ),
  );

  assert.match(html, /<div class="dep-row is-done" role="button" tabindex="0"/u);
  assert.equal(countClass(html, "modal"), 0, "没点之前不该挂一个空弹窗");
});
