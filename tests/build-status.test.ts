/**
 * 构建状态的两组单测。
 *
 * 第一组是 Shuttle 状态映射，锁住「什么算构建成功、什么算失败、什么算还没结论」这三件事，
 * 因为它们直接决定下游包能不能投（`lib/build/chain.ts` 只看快照状态）。
 *
 * 第二组是详情页那块「构建状态」的结构（MKACG-984 第 9 条）：它必须自己渲染一个
 * `.panel`、标题进 `.panel-hd`、表格进 `.panel-bd.flush.table-scroll` 里的 `table.grid`，
 * 两个降级分支用 `.tip`；9 列字段与只读语义一条都不能少。
 *
 * 映射表里只写实测见过的值（`lib/integrations/shuttle/FINDINGS.md`）：
 * 映射表里只写实测见过的值（`lib/integrations/shuttle/FINDINGS.md`）：
 * 任务状态见过 `UPLOAD_OK`、`UPLOAD_FAILED`、`UPLOAD_GIVEUP`、`APPLY_FAILED`、`UNKNOWN`，
 * 作业状态见过 `BUILD_OK`、`FAILED`、`WAIT`、`BUILDING`。没见过的值一律算「还在构建」，
 * 这几条断言就是防止有人日后把「未知当失败」改回来 —— 那会让下游被错误阻断。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildStatusPanel } from "../components/build-status";
import type { BuildStatusView } from "../lib/build";
import {
  EMPTY_JOB_LIST_GRACE_MS,
  mapShuttleState,
  summarizeBuild,
} from "../lib/build/status";

test("实测见过的成功状态映射为 success", () => {
  for (const state of ["BUILD_OK", "BUILD_SUCCESS", "UPLOAD_OK", "build_ok"]) {
    assert.equal(mapShuttleState(state), "success", state);
  }
});

test("实测见过的失败状态映射为 failed，含 Shuttle 原样的 UPLOAD_GIVEUP", () => {
  for (const state of ["FAILED", "UPLOAD_FAILED", "UPLOAD_GIVEUP", "upload_giveup"]) {
    assert.equal(mapShuttleState(state), "failed", state);
  }
});

test("实测的 APPLY_FAILED 算失败 —— CRP 在 apply 阶段拒绝执行，一个作业都没起", () => {
  assert.equal(mapShuttleState("APPLY_FAILED"), "failed");
  assert.equal(mapShuttleState("apply_failed"), "failed");
});

test("APPLY_FAILED 判失败时带上原始状态值，并说明这不是编译失败", () => {
  const verdict = summarizeBuild({ taskState: "APPLY_FAILED", jobStates: [] });

  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason ?? "", /APPLY_FAILED/);
  assert.match(verdict.reason ?? "", /不是编译失败/);
});

test("终止类状态映射为 canceled", () => {
  for (const state of ["TERMINATED", "CANCELLED", "KILLED"]) {
    assert.equal(mapShuttleState(state), "canceled", state);
  }
});

test("没见过的状态与空状态都算「还在构建」，不当成失败", () => {
  for (const state of ["", "APPLYING", "WAITING_FOR_SLAVE", "TOTALLY_MADE_UP_STATE", "某天新加的状态"]) {
    assert.equal(mapShuttleState(state), "building", state);
  }
});

test("任务成功且每个架构的作业都成功，才算这个包构建成功", () => {
  assert.deepEqual(
    summarizeBuild({ taskState: "BUILD_OK", jobStates: ["BUILD_OK", "BUILD_OK"] }),
    { status: "success", reason: null },
  );
});

test("任务说成功、作业还没报完时不下结论", () => {
  assert.deepEqual(
    summarizeBuild({ taskState: "BUILD_OK", jobStates: ["BUILD_OK", "BUILDING"] }),
    { status: "building", reason: null },
  );
});

test("任务说成功但没有任何作业时也算没结论，不冒认成功", () => {
  assert.deepEqual(summarizeBuild({ taskState: "BUILD_OK", jobStates: [] }), {
    status: "building",
    reason: null,
  });
});

test("任务成功但作业列表一直为空时，超过等待期限就判失败，不再永久停在构建中", () => {
  const observedAt = new Date("2026-11-19T10:00:00Z");
  const verdict = summarizeBuild({
    taskState: "BUILD_OK",
    jobStates: [],
    waitingSince: new Date(observedAt.getTime() - EMPTY_JOB_LIST_GRACE_MS),
    observedAt,
  });

  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason ?? "", /作业/);
});

test("任务成功但作业列表为空、还在等待期限内时继续等，不提前判失败", () => {
  const observedAt = new Date("2026-11-19T10:00:00Z");

  assert.deepEqual(
    summarizeBuild({
      taskState: "BUILD_OK",
      jobStates: [],
      waitingSince: new Date(observedAt.getTime() - 60_000),
      observedAt,
    }),
    { status: "building", reason: null },
  );
});

test("作业还在上报时不受等待期限影响 —— 等待期限只兜「列表一直是空」", () => {
  const observedAt = new Date("2026-11-19T10:00:00Z");

  assert.deepEqual(
    summarizeBuild({
      taskState: "BUILD_OK",
      jobStates: ["BUILD_OK", "BUILDING"],
      waitingSince: new Date(observedAt.getTime() - 24 * 60 * 60 * 1000),
      observedAt,
    }),
    { status: "building", reason: null },
  );
});

test("只要有一个架构的作业失败，整个包算失败 —— 缺架构的包不能投给下游", () => {
  const verdict = summarizeBuild({
    taskState: "BUILD_OK",
    jobStates: ["BUILD_OK", "FAILED"],
  });

  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason ?? "", /1 个架构的作业失败/);
});

test("任务状态失败时直接判失败，并带上任务状态给人看", () => {
  const verdict = summarizeBuild({ taskState: "UPLOAD_GIVEUP", jobStates: ["FAILED"] });

  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason ?? "", /UPLOAD_GIVEUP/);
});

test("作业被终止时判 canceled", () => {
  assert.deepEqual(summarizeBuild({ taskState: "BUILDING", jobStates: ["TERMINATED"] }), {
    status: "canceled",
    reason: "构建已被终止",
  });
});

test("任务还在构建、作业也没失败时继续等", () => {
  assert.deepEqual(summarizeBuild({ taskState: "BUILDING", jobStates: ["BUILDING"] }), {
    status: "building",
    reason: null,
  });
});

// ---------------------------------------------------------------------------
// 构建状态区块的结构（MKACG-984 第 9 条：迁到 v2 模块）
// ---------------------------------------------------------------------------

function statusView(overrides: Partial<BuildStatusView> = {}): BuildStatusView {
  return {
    releaseId: "release-1",
    version: "25.0.1",
    revision: 1,
    status: "building",
    statusLabel: "构建中",
    crpTopicId: "8867",
    workProgress: 10,
    workProgressLabel: "构建中",
    workProgressSyncedAt: new Date("2026-11-24T10:00:00Z"),
    tasks: [
      {
        snapshotId: "snap-1",
        packageName: "kwin",
        releaseVersion: "5.27.10",
        stage: "构建中",
        phase: "running",
        blockedBy: null,
        crpReleaseId: "CRP-9",
        shuttleTaskId: "SHU-7",
        arches: [
          { arch: "amd64", status: "success" },
          { arch: "arm64", status: "building" },
        ],
        durationMs: 125_000,
        lastPolledAt: new Date("2026-11-24T10:05:00Z"),
        reason: null,
      },
    ],
    ...overrides,
  };
}

function markupOf(view: BuildStatusView | null): string {
  return renderToStaticMarkup(createElement(BuildStatusPanel, { view }));
}

/** 数一段 HTML 里出现了几次某个 class：只数 `class="…"` 里逐字相同的 token。 */
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

const COLUMNS = [
  "软件包",
  "阶段",
  "提测版本",
  "架构状态",
  "耗时",
  "最近轮询",
  "原因",
  "CRP Release ID",
  "Shuttle 构建任务 ID",
];

test("构建状态区块自己渲染一个 .panel：标题进 .panel-hd，表格进 .panel-bd.flush.table-scroll", () => {
  const html = markupOf(statusView());

  assert.equal(countClass(html, "panel"), 1);
  assert.equal(countClass(html, "panel-hd"), 1);
  assert.equal(countClass(html, "panel-bd"), 2);
  assert.equal(countClass(html, "table-scroll"), 1);
  assert.equal(countClass(html, "grid"), 1);
  assert.equal(countClass(html, "flush"), 1);
  // 标题必须在 .panel-hd 里的 h2 上，不能是裸 h2。
  assert.match(html, /<div class="panel-hd"><h2>构建状态<\/h2>/u);
  assert.equal(countClass(html, "hint"), 1);
  // 没有面板套面板：整段 HTML 里只有一个 .panel。
  assert.doesNotMatch(html, /class="panel"[^]*class="panel"/u);
});

test("9 列一个不少，顺序与字段不变", () => {
  const html = markupOf(statusView());
  const headers = Array.from(html.matchAll(/<th(?: class="[^"]*")?>([^<]*)<\/th>/gu)).map(
    (match) => match[1],
  );

  assert.deepEqual(headers, COLUMNS);
});

test("代码列用 .col-mono，时间与耗时列用 .num", () => {
  const html = markupOf(statusView());

  // 软件包、提测版本、CRP Release ID、Shuttle 构建任务 ID 四列是代码。
  assert.equal(countClass(html, "col-mono"), 4);
  // 耗时、最近轮询两列是数字/时间：一个表头 + 一个单元格，各两处，共 4。
  assert.equal(countClass(html, "num"), 4);
  assert.match(html, /<th class="num">耗时<\/th>/u);
  assert.match(html, /<th class="num">最近轮询<\/th>/u);
  assert.match(html, /<td class="num">2 分钟<\/td>/u);
  assert.match(html, /<td class="num">2026-11-24 10:05:00 UTC<\/td>/u);
});

test("一行数据里的真实字段都渲染出来，不因为原型列少而删列", () => {
  const html = markupOf(statusView());

  assert.match(html, /kwin/u);
  assert.match(html, /5\.27\.10/u);
  assert.match(html, /CRP-9/u);
  assert.match(html, /SHU-7/u);
  assert.match(html, /amd64：成功；arm64：构建中/u);
  assert.match(html, /2 分钟/u);
  assert.match(html, /2026-11-24 10:05:00 UTC/u);
  assert.match(html, /提测状态：构建中/u);
  assert.match(html, /CRP Topic ID：<code>8867<\/code>/u);
});

test("原因、CRP Release ID、Shuttle 任务 ID 缺失时写破折号，不留空白单元格", () => {
  const view = statusView({
    tasks: [
      {
        ...statusView().tasks[0]!,
        reason: null,
        crpReleaseId: null,
        shuttleTaskId: null,
        arches: [],
        durationMs: null,
        lastPolledAt: null,
      },
    ],
  });
  const html = markupOf(view);

  assert.match(html, /<td>—<\/td>/u);
  assert.match(html, /<td class="col-mono">—<\/td>/u);
  assert.match(html, /<td class="num">—<\/td>/u);
});

test("记录不存在时同样是 .panel，提示用 .tip 放在 .panel-bd 里，没有表格", () => {
  const html = markupOf(null);

  assert.equal(countClass(html, "panel"), 1);
  assert.equal(countClass(html, "panel-hd"), 1);
  assert.equal(countClass(html, "panel-bd"), 1);
  assert.equal(countClass(html, "tip"), 1);
  assert.equal(countClass(html, "grid"), 0);
  assert.doesNotMatch(html, /<table/u);
  assert.match(html, /这条提测记录不存在/u);
});

test("提测还没有软件包时也是 .tip 提示，不留空表格", () => {
  const html = markupOf(statusView({ tasks: [] }));

  assert.equal(countClass(html, "tip"), 1);
  assert.doesNotMatch(html, /<table/u);
  assert.match(html, /这条提测还没有软件包/u);
});

test("组件源码里不再出现 v1 的 .section-title 与 .data-table（AC7）", () => {
  const source = readFileSync(join(process.cwd(), "components/build-status.tsx"), "utf8");

  assert.equal((source.match(/section-title/gu) ?? []).length, 0);
  assert.equal((source.match(/data-table/gu) ?? []).length, 0);
  // 反向确认：v2 的三个模块确实在里面。
  assert.match(source, /className="panel"/u);
  assert.match(source, /className="grid"/u);
});
