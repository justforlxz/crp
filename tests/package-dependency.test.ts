import assert from "node:assert/strict";
import test from "node:test";

import {
  findDependencyCycle,
  formatCycle,
  type DependencyEdge,
} from "../lib/packages/dependencyGraph";

test("没有依赖边时不报环", () => {
  assert.equal(findDependencyCycle([]), null);
});

test("链式依赖 A→B→C 不成环", () => {
  const edges: DependencyEdge[] = [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ];

  assert.equal(findDependencyCycle(edges), null);
});

test("自依赖 A→A 被识别为环", () => {
  assert.deepEqual(findDependencyCycle([{ from: "A", to: "A" }]), ["A", "A"]);
});

test("二元环 A→B→A 被识别", () => {
  const edges: DependencyEdge[] = [
    { from: "A", to: "B" },
    { from: "B", to: "A" },
  ];

  assert.deepEqual(findDependencyCycle(edges), ["A", "B", "A"]);
});

test("三元环 A→B→C→A 被识别，且回路首尾同名", () => {
  const edges: DependencyEdge[] = [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
    { from: "C", to: "A" },
  ];

  const cycle = findDependencyCycle(edges);

  assert.equal(cycle?.length, 4);
  assert.equal(cycle?.[0], cycle?.[cycle.length - 1]);
  assert.deepEqual(new Set(cycle), new Set(["A", "B", "C"]).union(new Set([cycle[0]])));
});

test("环不在入口节点时也能找到", () => {
  // X 指向一条与环无关的链，环在 D→E→D 上。
  const edges: DependencyEdge[] = [
    { from: "X", to: "Y" },
    { from: "D", to: "E" },
    { from: "E", to: "D" },
  ];

  assert.deepEqual(findDependencyCycle(edges), ["D", "E", "D"]);
});

test("环的路径拼给人看是 A → B → C → A", () => {
  assert.equal(formatCycle(["A", "B", "C", "A"]), "A → B → C → A");
});
