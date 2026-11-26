/**
 * 提测详情页的「状态流转与活动记录」与 `.risk` 的推导（MKACG-970 / MKACG-984）。
 *
 * 这两块的内容是纯函数算出来的，所以这里直接喂数据、断言结果，不连数据库、不渲染页面。
 * 仍然载入 `.env`：`lib/releases` 的出口会连带建出 Prisma 客户端，与仓库其它用例一致。
 * 锁住的是页面上那几条容易改坏的规矩（`.agents/spec/design/test-cases.md`）：
 *
 * - FUNC-09：`.tl-item` 按时间正序，当前状态排在最后一条，并带 `.is-cur`；
 * - 时间线永远有「创建提测」与「当前状态」两条，没有更新历史也不会出现空列表；
 * - 每条都有时间戳（UI-13），当前状态用工作流进度的最近同步时间，不拿别的字段冒充；
 * - 一条留痕一个条目，三个包列表各自独立、空的就不写；
 * - FUNC-08：`.risk` 只在真的有问题时出现 —— 构建没通过、或者这条提测现在改不了；
 *   两样都没有就是空数组，页面按空数组整块不渲染，不留空壳。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRiskItems,
  buildTimeline,
  formatTime,
  historyNotes,
  historyToneOf,
  statusDotTone,
  timelineToneOf,
  type DetailRiskItem,
  type DetailTimelineEntry,
} from "../app/(app)/releases/[id]/detailView";
import type { ReleaseDetailHistoryRow } from "../lib/releases";

const CREATED_AT = new Date("2026-11-18T02:10:00Z");
const SYNCED_AT = new Date("2026-11-18T03:00:00Z");

/** 一条留痕：默认什么都不带，各用例只写自己关心的字段。 */
function historyRow(overrides: Partial<ReleaseDetailHistoryRow> = {}): ReleaseDetailHistoryRow {
  return {
    id: "h1",
    action: "append",
    packageNames: [],
    revisionBefore: 1,
    revisionAfter: 2,
    abandonedCrpReleaseIds: [],
    redispatchedPackageNames: [],
    createdAt: new Date("2026-11-18T02:20:00Z"),
    operatorName: "李伟",
    abandonedPackages: [],
    ...overrides,
  };
}

type TimelineInput = Parameters<typeof buildTimeline>[0];

/** 时间线的入参：默认是一条刚建好、还没投递的提测。 */
function timelineInput(overrides: Partial<TimelineInput> = {}): TimelineInput {
  return {
    status: "queued",
    revision: 1,
    workProgress: null,
    workProgressLabel: null,
    workProgressError: null,
    workProgressSyncedAt: null,
    history: [],
    createdByName: "林小志",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function titles(entries: DetailTimelineEntry[]): string[] {
  return entries.map((entry) => entry.title);
}

type RiskInput = Parameters<typeof buildRiskItems>[0];

function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return { status: "queued", lockReason: null, ...overrides };
}

function riskKeys(items: DetailRiskItem[]): string[] {
  return items.map((item) => item.key);
}

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

test("没有更新历史时，时间线仍有「创建提测」与「当前状态」两条，按时间正序", () => {
  const entries = buildTimeline(timelineInput());

  assert.equal(entries.length, 2);
  assert.deepEqual(
    titles(entries).map((title) => title.split(" · ")[0]),
    ["创建提测", "当前状态"],
  );
  // 正序：先建提测，最后一条是当前状态（FUNC-09）。
  assert.equal(entries[0]?.key, "created");
  assert.equal(entries[1]?.key, "current");
});

test("每条记录都有配色档位：创建与留痕是绿，当前状态由状态推导", () => {
  const entries = buildTimeline(timelineInput({ history: [historyRow()] }));

  // 默认状态是排队中（进行中），所以当前状态那条是 .is-cur。
  assert.deepEqual(
    entries.map((entry) => entry.tone),
    ["is-ok", "is-ok", "is-cur"],
  );
});

test("当前状态那条的档位跟随提测状态，与概要条的 .dot 同一份语义", () => {
  const toneOf = (status: string) => buildTimeline(timelineInput({ status })).at(-1)?.tone;

  assert.equal(toneOf("success"), "is-ok");
  assert.equal(toneOf("failed"), "is-bad");
  assert.equal(toneOf("partial_failure"), "is-bad");
  assert.equal(toneOf("abandoned"), "is-bad");
  assert.equal(toneOf("pending"), "is-cur");
  assert.equal(toneOf("dispatching"), "is-cur");
  assert.equal(toneOf("building"), "is-cur");
});

test("放弃主题的留痕是红的，补包换包是绿的", () => {
  const entries = buildTimeline(
    timelineInput({
      history: [
        historyRow({ id: "h-append", action: "append" }),
        historyRow({ id: "h-abandon", action: "abandon_topic" }),
      ],
    }),
  );

  assert.deepEqual(
    entries.map((entry) => entry.tone),
    ["is-ok", "is-ok", "is-bad", "is-cur"],
  );
});

test("每条记录都有时间戳：当前状态用工作流进度的最近同步时间", () => {
  const entries = buildTimeline(timelineInput({ workProgressSyncedAt: SYNCED_AT }));

  assert.equal(entries[0]?.at, "2026-11-18 02:10:00 UTC");
  assert.equal(entries[1]?.at, "2026-11-18 03:00:00 UTC");
});

test("没同步过工作流进度时，当前状态的时间戳是破折号，不编一个时间", () => {
  const entries = buildTimeline(timelineInput({ workProgressSyncedAt: null }));

  assert.equal(entries[1]?.at, "—");
});

test("当前状态用中文状态名，不用数据库里的英文枚举值", () => {
  const entries = buildTimeline(timelineInput({ status: "success" }));

  assert.equal(entries[1]?.title, "当前状态 · 成功");
});

test("读不到工作流进度时，当前状态那条写明读不到，而不是显示 0", () => {
  const entries = buildTimeline(
    timelineInput({ workProgress: null, workProgressError: "CRP 连接失败" }),
  );

  assert.ok(entries[1]?.notes.includes("CRP 连接失败"));
});

test("一条留痕排在创建提测之后、当前状态之前", () => {
  const entries = buildTimeline(
    timelineInput({
      revision: 2,
      history: [
        historyRow({ id: "h-late", revisionBefore: 1, revisionAfter: 2 }),
      ],
    }),
  );

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["created", "history-h-late", "current"],
  );
});

test("一条留痕带上操作人，以及三个包列表；空的就不写那一行", () => {
  const entries = buildTimeline(
    timelineInput({
      history: [
        historyRow({
          packageNames: ["kwin"],
          abandonedPackages: ["deepin-daemon"],
          redispatchedPackageNames: ["dde-dock"],
        }),
      ],
    }),
  );

  assert.deepEqual(entries[1]?.notes, [
    "操作人：李伟",
    "加的包：kwin",
    "放弃的包：deepin-daemon",
    "重投的包：dde-dock",
  ]);

  const bare = buildTimeline(timelineInput({ history: [historyRow()] }));
  assert.deepEqual(bare[1]?.notes, ["操作人：李伟"]);
});

test("放弃的包按包名对不上时露出 CRP Release ID，两条不重复写", () => {
  assert.deepEqual(
    historyNotes(historyRow({ abandonedCrpReleaseIds: ["CRP-1", "CRP-2"] })),
    ["放弃的 CRP Release：CRP-1、CRP-2"],
  );

  assert.deepEqual(
    historyNotes(
      historyRow({ abandonedPackages: ["kwin"], abandonedCrpReleaseIds: ["CRP-1"] }),
    ),
    ["放弃的包：kwin"],
  );
});

test("时间按 UTC 展示，空时间写破折号", () => {
  assert.equal(formatTime(CREATED_AT), "2026-11-18 02:10:00 UTC");
  assert.equal(formatTime(null), "—");
});

// ---------------------------------------------------------------------------
// 状态色点
// ---------------------------------------------------------------------------

test("提测状态按 design.md 第五节映射到 .dot 的配色档位", () => {
  assert.equal(statusDotTone("success"), "is-ok");
  assert.equal(statusDotTone("failed"), "is-bad");
  assert.equal(statusDotTone("partial_failure"), "is-bad");
  assert.equal(statusDotTone("abandoned"), "is-warn");
  assert.equal(statusDotTone("dispatching"), "is-run");
  assert.equal(statusDotTone("building"), "is-run");
  assert.equal(statusDotTone("pending"), "is-wait");
  // 认不出的状态按等待处理，不抛错、不显示成成功色。
  assert.equal(statusDotTone("unknown"), "is-wait");
});

test(".tl-item 只有绿 / 红 / 蓝三条规则，五档色点压成三档", () => {
  // 成功 → 绿。
  assert.equal(timelineToneOf("success"), "is-ok");
  // 失败、部分失败、已放弃 → 红（.tl-item 没有橙色规则）。
  assert.equal(timelineToneOf("failed"), "is-bad");
  assert.equal(timelineToneOf("partial_failure"), "is-bad");
  assert.equal(timelineToneOf("abandoned"), "is-bad");
  // 排队中、投递中、构建中、认不出的状态 → 蓝（进行中，.tl-item 没有灰色规则）。
  assert.equal(timelineToneOf("pending"), "is-cur");
  assert.equal(timelineToneOf("dispatching"), "is-cur");
  assert.equal(timelineToneOf("building"), "is-cur");
  assert.equal(timelineToneOf("unknown"), "is-cur");
});

test("留痕动作的档位：补包换包是绿的，放弃主题是红的", () => {
  assert.equal(historyToneOf("append"), "is-ok");
  assert.equal(historyToneOf("replace"), "is-ok");
  assert.equal(historyToneOf("abandon_topic"), "is-bad");
});

// ---------------------------------------------------------------------------
// risk
// ---------------------------------------------------------------------------

test("没有风险也不阻塞时不出 .risk：包为 0、刚建好的提测就是这样", () => {
  assert.deepEqual(buildRiskItems(riskInput({ status: "queued" })), []);
});

test("构建没通过时出一条构建风险", () => {
  assert.deepEqual(riskKeys(buildRiskItems(riskInput({ status: "failed" }))), ["build"]);
  assert.deepEqual(
    riskKeys(buildRiskItems(riskInput({ status: "partial_failure" }))),
    ["build"],
  );
});

test("现在改不了时出一条阻塞，正文就是服务端那句原因，页面不改写", () => {
  const reason = "这条提测已经转测（CRP 工作流进度 20：转测试中），转测之后不能再补包或换包。";
  const items = buildRiskItems(riskInput({ status: "success", lockReason: reason }));

  assert.deepEqual(riskKeys(items), ["lock"]);
  assert.equal(items[0]?.body, reason);
});

test("构建失败且现在改不了时两条都出，构建那条在前", () => {
  const items = buildRiskItems(
    riskInput({ status: "failed", lockReason: "有软件包正在投递，等这一轮投递结束再更新。" }),
  );

  assert.deepEqual(riskKeys(items), ["build", "lock"]);
});
