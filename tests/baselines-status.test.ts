/**
 * 基线状态判定的单元测试。
 *
 * 状态是页面「状态」列的唯一来源，四条判定各锁一个用例：消失优先、失败压过成功、
 * 成功过、从未同步。最后一个用例堵的是最容易犯的错——把失败的同步显示成「已同步」。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BASELINE_STATE_LABELS, baselineState } from "../lib/baselines/status";

const SYNCED_AT = new Date("2026-11-18T01:00:00Z");
const MISSING_AT = new Date("2026-11-18T09:00:00Z");

test("从 CRP 消失的基线是「已消失」，与同步结果无关", () => {
  const state = baselineState({
    missingAt: MISSING_AT,
    syncedAt: SYNCED_AT,
    latestRunStatus: "success",
  });

  assert.equal(state, "missing");
  assert.equal(BASELINE_STATE_LABELS[state], "已消失");
});

test("最近一次同步失败是「同步失败」，不会被上一次成功的时间戳盖住", () => {
  const state = baselineState({
    missingAt: null,
    syncedAt: SYNCED_AT,
    latestRunStatus: "failed",
  });

  assert.equal(state, "failed");
  assert.equal(BASELINE_STATE_LABELS[state], "同步失败");
});

test("成功同步过是「已同步」", () => {
  const state = baselineState({
    missingAt: null,
    syncedAt: SYNCED_AT,
    latestRunStatus: "success",
  });

  assert.equal(state, "synced");
  assert.equal(BASELINE_STATE_LABELS[state], "已同步");
});

test("从没同步过是「未同步」", () => {
  const state = baselineState({
    missingAt: null,
    syncedAt: null,
    latestRunStatus: null,
  });

  assert.equal(state, "unsynced");
  assert.equal(BASELINE_STATE_LABELS[state], "未同步");
});

test("同步进行中不改写已有状态：有成功时间就仍显示「已同步」", () => {
  const state = baselineState({
    missingAt: null,
    syncedAt: SYNCED_AT,
    latestRunStatus: "running",
  });

  assert.equal(state, "synced");
});
