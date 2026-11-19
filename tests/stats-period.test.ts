/**
 * 工作台统计的口径（A15）。
 *
 * 锁住两件事：
 *
 * - 「本周」是滚动的最近 7 天，不按自然周、不对齐零点 —— 页面副标题写的就是这两个字，
 *   口径必须与它一致，否则同一句话在两处有两种含义。
 * - 成功率的分母是「已经有结论的提测」，还在排队 / 投递 / 构建的不算进去；
 *   一条结论都没有时返回空，页面显示「—」而不是 0%（0% 会被读成「全失败」）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { recentWindowStart, SETTLED_RELEASE_STATUSES, successRatePercent } from "../lib/stats/period";

test("统计窗口是最近 7 天：起点正好比现在早 7×24 小时", () => {
  const now = new Date("2026-11-19T07:30:00Z");

  assert.equal(recentWindowStart(now).toISOString(), "2026-11-12T07:30:00.000Z");
});

test("统计窗口按参数改变天数，跨月也算得对", () => {
  const now = new Date("2026-03-02T00:00:00Z");

  assert.equal(recentWindowStart(now, 1).toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(recentWindowStart(now, 2).toISOString(), "2026-02-28T00:00:00.000Z");
});

test("成功率四舍五入到整数百分比", () => {
  assert.equal(successRatePercent(1, 2), 50);
  assert.equal(successRatePercent(1, 3), 33);
  assert.equal(successRatePercent(2, 3), 67);
  assert.equal(successRatePercent(0, 4), 0);
  assert.equal(successRatePercent(5, 5), 100);
});

test("一条结论都没有时返回空，不返回 0 —— 0% 会被读成「全失败」", () => {
  assert.equal(successRatePercent(0, 0), null);
});

test("「已有结论」的提测状态是成功、失败、部分失败与已放弃，在跑的都不算", () => {
  assert.deepEqual([...SETTLED_RELEASE_STATUSES].sort(), [
    "abandoned",
    "failed",
    "partial_failure",
    "success",
  ]);
});
