/**
 * 依赖链推进判定的单测。
 *
 * 锁住 A12 的两条 MUST 与两条 MUST NOT，全部用纯函数断言，不需要数据库、不需要网络：
 *
 * - AC1 的投递顺序：三层链 `a → b → c` 严格按 a、b、c 投，b 只在 a 成功后才有资格投；
 * - AC2 的阻断：a 失败时 b、c 都不得投递，并且要能说出「因上游 a 失败」；
 * - MUST NOT 并发投递：一次只给一个 `next`；
 * - MUST NOT 跳过失败继续投：链上有失败包时不再给 `next`，哪怕还有别的包可以投。
 *
 * 节点顺序按包名传入（与 `lib/build/service.ts` 的读取顺序一致），所以「同样输入同样输出」
 * 可以直接断言。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateChain,
  type ChainNode,
  type ChainStatus,
} from "../lib/build/chain";

/** 三层链：b 依赖 a，c 依赖 b。 */
function threeLayer(
  statuses: { a?: ChainStatus; b?: ChainStatus; c?: ChainStatus } = {},
): ChainNode[] {
  return [
    { snapshotId: "snap-a", packageName: "a", status: statuses.a ?? "pending", upstreamNames: [] },
    {
      snapshotId: "snap-b",
      packageName: "b",
      status: statuses.b ?? "pending",
      upstreamNames: ["a"],
    },
    {
      snapshotId: "snap-c",
      packageName: "c",
      status: statuses.c ?? "pending",
      upstreamNames: ["b"],
    },
  ];
}

test("全都会等待时，先投最上游的 a，只投一个", () => {
  const result = evaluateChain(threeLayer());

  assert.equal(result.next?.packageName, "a");
  assert.deepEqual(result.newlyBlocked, []);
  assert.equal(result.outcome, null);
});

test("a 还在构建时不投 b —— 上游没成功就没有下游的资格", () => {
  const result = evaluateChain(threeLayer({ a: "building" }));

  assert.equal(result.next, null);
  assert.equal(result.outcome, null);
});

test("a 成功后投 b，b 成功后投 c：顺序天然是 a、b、c", () => {
  assert.equal(evaluateChain(threeLayer({ a: "success" })).next?.packageName, "b");
  assert.equal(
    evaluateChain(threeLayer({ a: "success", b: "success" })).next?.packageName,
    "c",
  );
});

test("全部成功给出 success 结局", () => {
  const result = evaluateChain(threeLayer({ a: "success", b: "success", c: "success" }));

  assert.equal(result.outcome, "success");
  assert.equal(result.next, null);
});

test("a 失败时 b、c 都被阻断，并指出是 a 造成的", () => {
  const result = evaluateChain(threeLayer({ a: "failed" }));

  assert.deepEqual(
    result.newlyBlocked.map((item) => item.packageName),
    ["b", "c"],
  );

  for (const item of result.newlyBlocked) {
    assert.equal(item.blockedBySnapshotId, "snap-a");
    assert.equal(item.blockedByName, "a");
    assert.match(item.reason, /因上游 a 构建失败而阻断/);
  }
});

test("a 失败后整条链不再给投递对象，并且结局是 failed", () => {
  const result = evaluateChain(threeLayer({ a: "failed" }));

  assert.equal(result.next, null);
  assert.equal(result.outcome, "failed");
});

test("有成功也有失败时结局是 partial_failure", () => {
  const result = evaluateChain(threeLayer({ a: "success", b: "failed" }));

  assert.equal(result.outcome, "partial_failure");
  assert.deepEqual(
    result.newlyBlocked.map((item) => item.packageName),
    ["c"],
  );
  assert.equal(result.newlyBlocked[0]?.blockedByName, "b");
});

test("链上有失败包时不再投别的包，那些包也一并标成阻断", () => {
  // y 的上游 x 已经成功，只是「本次不再投递」，所以原因不是「上游失败」。
  const nodes: ChainNode[] = [
    { snapshotId: "s-a", packageName: "a", status: "failed", upstreamNames: [] },
    { snapshotId: "s-x", packageName: "x", status: "success", upstreamNames: [] },
    { snapshotId: "s-y", packageName: "y", status: "pending", upstreamNames: ["x"] },
  ];

  const result = evaluateChain(nodes);

  assert.equal(result.next, null);
  assert.equal(result.outcome, "partial_failure");
  assert.deepEqual(
    result.newlyBlocked.map((item) => item.packageName),
    ["y"],
  );
  assert.equal(result.newlyBlocked[0]?.blockedBySnapshotId, "s-a");
  assert.match(result.newlyBlocked[0]?.reason ?? "", /同一提测里 a 构建失败/);
});

test("有包还在构建时不判终局 —— 否则它的结果永远写不回来", () => {
  const result = evaluateChain(threeLayer({ a: "failed", b: "building" }));

  assert.equal(result.outcome, null, "b 还在构建，不能现在判失败");
  assert.equal(result.next, null);
  // b 在构建、不在「待投递」，所以不会被标成阻断。
  assert.deepEqual(
    result.newlyBlocked.map((item) => item.packageName),
    ["c"],
  );
});

test("最后一个在构建的包出结论后才给终局", () => {
  const result = evaluateChain(threeLayer({ a: "failed", b: "failed", c: "success" }));

  assert.equal(result.outcome, "partial_failure");
});

test("已抢占（dispatching）的包也算还在构建，不给终局", () => {
  const result = evaluateChain(
    threeLayer({ a: "dispatching", b: "failed" }),
  );

  assert.equal(result.outcome, null);
});

test("清单外的上游不参与判定，不会把它当成「还没成功」而卡住", () => {
  const nodes: ChainNode[] = [
    {
      snapshotId: "s-a",
      packageName: "a",
      status: "pending",
      upstreamNames: ["不在这次提测里的包"],
    },
  ];

  assert.equal(evaluateChain(nodes).next?.packageName, "a");
});

test("已经被阻断过的包不再重复出现在 newlyBlocked 里", () => {
  const result = evaluateChain(threeLayer({ a: "failed", b: "failed", c: "failed" }));

  assert.deepEqual(result.newlyBlocked, []);
  assert.equal(result.outcome, "failed");
});

test("阻断会沿依赖边传递，不只看直接上游", () => {
  // d 依赖 c，c 依赖 b，b 依赖 a：a 失败时 d 也要被阻断，并且指回 a。
  const nodes: ChainNode[] = [
    { snapshotId: "s-a", packageName: "a", status: "failed", upstreamNames: [] },
    { snapshotId: "s-b", packageName: "b", status: "pending", upstreamNames: ["a"] },
    { snapshotId: "s-c", packageName: "c", status: "pending", upstreamNames: ["b"] },
    { snapshotId: "s-d", packageName: "d", status: "pending", upstreamNames: ["c"] },
  ];

  const result = evaluateChain(nodes);

  assert.deepEqual(
    result.newlyBlocked.map((item) => item.packageName),
    ["b", "c", "d"],
  );

  for (const item of result.newlyBlocked) {
    assert.equal(item.blockedByName, "a", `${item.packageName} 的阻断原因应指回 a`);
  }
});

test("已放弃的快照不参与推演", () => {
  const nodes: ChainNode[] = [
    { snapshotId: "s-a", packageName: "a", status: "abandoned", upstreamNames: [] },
  ];

  const result = evaluateChain(nodes);

  assert.equal(result.next, null);
  assert.deepEqual(result.newlyBlocked, []);
  assert.equal(result.outcome, null);
});
