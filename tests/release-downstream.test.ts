/**
 * 传递下游计算的单元测试（AC7）。
 *
 * 纯函数，不碰数据库也不碰网络：给定依赖边与被改动的包，输出必须覆盖全部多层下游、
 * 不去重失败、不越出这次提测的清单。单链、分叉、菱形三种形态各一例是验收要求的底线，
 * 另外补上环与清单外依赖两例，防止脏数据把链算崩。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectDownstream } from "../lib/releases/downstream";

/** 边 `{ from, to }` 表示 `from` 依赖 `to`，即 `to` 是 `from` 的上游。 */
function edges(pairs: Array<[string, string]>) {
  return pairs.map(([from, to]) => ({ from, to }));
}

function inside(...names: string[]): Set<string> {
  return new Set(names);
}

test("单链：改 A 时 B、C 都是它的传递下游", () => {
  const result = collectDownstream(
    ["A"],
    edges([
      ["B", "A"],
      ["C", "B"],
    ]),
    inside("A", "B", "C"),
  );

  assert.deepEqual(result, ["B", "C"]);
});

test("分叉：B、C 都依赖 A 时改 A，两者都在结果里", () => {
  const result = collectDownstream(
    ["A"],
    edges([
      ["B", "A"],
      ["C", "A"],
    ]),
    inside("A", "B", "C"),
  );

  assert.deepEqual(result, ["B", "C"]);
});

test("菱形：改 A 时 B、C、D 各出现一次", () => {
  const result = collectDownstream(
    ["A"],
    edges([
      ["B", "A"],
      ["C", "A"],
      ["D", "B"],
      ["D", "C"],
    ]),
    inside("A", "B", "C", "D"),
  );

  assert.deepEqual(result, ["B", "C", "D"]);
});

test("改下游不影响上游：改 D 时结果为空", () => {
  const result = collectDownstream(
    ["D"],
    edges([
      ["B", "A"],
      ["D", "B"],
    ]),
    inside("A", "B", "D"),
  );

  assert.deepEqual(result, []);
});

test("同时改多个包：下游合并去重", () => {
  const result = collectDownstream(
    ["A", "B"],
    edges([
      ["B", "A"],
      ["C", "A"],
      ["C", "B"],
    ]),
    inside("A", "B", "C"),
  );

  assert.deepEqual(result, ["C"]);
});

test("清单外的包不参与：上游或下游不在这次提测里就跳过", () => {
  const result = collectDownstream(
    ["A"],
    edges([
      ["B", "A"],
      ["X", "B"],
    ]),
    inside("A", "B"),
  );

  assert.deepEqual(result, ["B"]);
});

test("环不会让计算停不下来：A→B→A 只回报一次 B", () => {
  const result = collectDownstream(
    ["A"],
    edges([
      ["B", "A"],
      ["A", "B"],
    ]),
    inside("A", "B"),
  );

  assert.deepEqual(result, ["B"]);
});
