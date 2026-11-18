import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCycle,
  sortByDependencies,
  type DependencyEdge,
} from "../lib/packages/dependencyGraph";
import { buildSoftwareView, type SoftwareEntry } from "../lib/projects/softwareView";

// ---------------------------------------------------------------------------
// sortByDependencies：项目卡片上的「拓扑排序结果」
// ---------------------------------------------------------------------------

test("清单为空时排序结果为空、没有环", () => {
  assert.deepEqual(sortByDependencies([], []), { order: [], cycle: null });
});

test("三层依赖链按上游在前排序", () => {
  const edges: DependencyEdge[] = [
    { from: "dde-dock", to: "dde-session-shell" },
    { from: "dde-session-shell", to: "deepin-polkit-agent" },
  ];

  const sorted = sortByDependencies(
    ["dde-dock", "deepin-polkit-agent", "dde-session-shell"],
    edges,
  );

  assert.deepEqual(sorted.order, ["deepin-polkit-agent", "dde-session-shell", "dde-dock"]);
  assert.equal(sorted.cycle, null);
});

test("没有依赖关系的包按名字排，顺序稳定", () => {
  const first = sortByDependencies(["kwin", "dde-dock", "dde-appearance"], []);
  const second = sortByDependencies(["dde-appearance", "kwin", "dde-dock"], []);

  assert.deepEqual(first.order, ["dde-appearance", "dde-dock", "kwin"]);
  assert.deepEqual(second.order, first.order);
});

test("菱形依赖里上游排在两个下游之前", () => {
  const edges: DependencyEdge[] = [
    { from: "dde-control-center", to: "dde-appearance" },
    { from: "dde-dock", to: "dde-appearance" },
    { from: "dde-control-center", to: "dde-dock" },
  ];

  const sorted = sortByDependencies(["dde-control-center", "dde-dock", "dde-appearance"], edges);

  assert.deepEqual(sorted.order, ["dde-appearance", "dde-dock", "dde-control-center"]);
  assert.equal(sorted.cycle, null);
});

test("清单外的上游不参与排序", () => {
  const edges: DependencyEdge[] = [
    { from: "dde-dock", to: "deepin-polkit-agent" },
    { from: "dde-dock", to: "kwin" },
  ];

  const sorted = sortByDependencies(["dde-dock", "kwin"], edges);

  assert.deepEqual(sorted.order, ["kwin", "dde-dock"]);
  assert.equal(sorted.cycle, null);
});

test("重复的节点名按一个算", () => {
  const sorted = sortByDependencies(["kwin", "kwin"], []);

  assert.deepEqual(sorted.order, ["kwin"]);
});

test("二元环被报出来，环上的包仍然全部列出", () => {
  const edges: DependencyEdge[] = [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ];

  const sorted = sortByDependencies(["a", "b", "c"], edges);

  assert.deepEqual(sorted.cycle, ["a", "b", "a"]);
  assert.deepEqual(sorted.order.slice().sort(), ["a", "b", "c"]);
});

test("自依赖算环，报成首尾同名", () => {
  const sorted = sortByDependencies(["kwin"], [{ from: "kwin", to: "kwin" }]);

  assert.deepEqual(sorted.cycle, ["kwin", "kwin"]);
  assert.deepEqual(sorted.order, ["kwin"]);
});

test("环只占一部分时，环外的包仍然排得出顺序", () => {
  const edges: DependencyEdge[] = [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "c", to: "b" },
  ];

  const sorted = sortByDependencies(["a", "b", "c"], edges);

  assert.deepEqual(sorted.cycle, ["a", "b", "a"]);
  // a、b 排在环里排不动，c 依赖 b 也排不出来，所以三个都在尾部，但一个都不少。
  assert.deepEqual(sorted.order.slice().sort(), ["a", "b", "c"]);
});

test("环的文字形式用箭头连接", () => {
  assert.equal(formatCycle(["a", "b", "a"]), "a → b → a");
});

// ---------------------------------------------------------------------------
// buildSoftwareView：项目卡片上的软件数、依赖数、顺序、环告警
// ---------------------------------------------------------------------------

function entry(
  packageName: string,
  upstreamNames: string[] = [],
  trackedBranch = "develop/eagle",
): SoftwareEntry {
  return { packageName, trackedBranch, upstreamNames, lastSubmittedCommit: null };
}

test("软件数与依赖数只数清单内部的关系", () => {
  const view = buildSoftwareView([
    entry("dde-dock", ["dde-session-shell", "kwin"]),
    entry("dde-session-shell", ["deepin-polkit-agent"]),
    entry("kwin", []),
  ]);

  assert.equal(view.count, 3);
  // dde-dock→dde-session-shell 与 dde-dock→kwin 在清单内；dde-session-shell→deepin-polkit-agent
  // 的上游不在清单里，不计入依赖数。
  assert.equal(view.dependencyCount, 2);
  assert.equal(view.cycle, null);
});

test("清单按投递顺序排列，条目带着各自的跟踪分支", () => {
  const view = buildSoftwareView([
    entry("dde-dock", ["dde-session-shell"], "develop/eagle"),
    entry("dde-session-shell", [], "develop/master"),
  ]);

  assert.deepEqual(view.order, ["dde-session-shell", "dde-dock"]);
  assert.deepEqual(
    view.entries.map((item) => [item.packageName, item.trackedBranch]),
    [
      ["dde-session-shell", "develop/master"],
      ["dde-dock", "develop/eagle"],
    ],
  );
});

test("清单成环时给出环，而清单条目不丢", () => {
  const view = buildSoftwareView([
    entry("a", ["b"]),
    entry("b", ["a"]),
    entry("c", []),
  ]);

  assert.deepEqual(view.cycle, ["a", "b", "a"]);
  assert.equal(view.count, 3);
  assert.deepEqual(view.entries.map((item) => item.packageName).slice().sort(), ["a", "b", "c"]);
  assert.equal(view.dependencyCount, 2);
});

test("空清单不会出错，数字都是零", () => {
  const view = buildSoftwareView([]);

  assert.deepEqual(view, { count: 0, dependencyCount: 0, order: [], cycle: null, entries: [] });
});

test("清单外的上游仍然留在条目上，页面据此标出「清单外」", () => {
  const view = buildSoftwareView([entry("dde-dock", ["kwin"])]);

  assert.deepEqual(view.entries[0].upstreamNames, ["kwin"]);
  assert.equal(view.dependencyCount, 0);
});
