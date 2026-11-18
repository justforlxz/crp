import assert from "node:assert/strict";
import test from "node:test";

import { baselineBlockReason } from "../lib/projects/baselineGate";

test("已同步的基线可以用", () => {
  assert.equal(baselineBlockReason({ name: "eagle-1071", state: "synced" }), null);
});

test("已从 CRP 分支列表消失的基线被拒绝，并说明原因", () => {
  const reason = baselineBlockReason({ name: "eagle-1071", state: "missing" });

  assert.ok(reason !== null);
  assert.match(reason, /eagle-1071/);
  assert.match(reason, /已从 CRP 分支列表消失/);
});

test("最近一次同步失败的基线被拒绝，与「已同步」不混用", () => {
  const reason = baselineBlockReason({ name: "snipe-2500u2", state: "failed" });

  assert.ok(reason !== null);
  assert.match(reason, /snipe-2500u2/);
  assert.match(reason, /同步失败/);
});

test("从未同步过的基线被拒绝", () => {
  const reason = baselineBlockReason({ name: "eagle-1076", state: "unsynced" });

  assert.ok(reason !== null);
  assert.match(reason, /还没有同步过/);
});

test("四种状态里只有 synced 放行", () => {
  const states = ["synced", "missing", "failed", "unsynced"] as const;
  const allowed = states.filter((state) => baselineBlockReason({ name: "b", state }) === null);

  assert.deepEqual(allowed, ["synced"]);
});
