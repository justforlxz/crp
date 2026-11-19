/**
 * 提测阻断条件与「有更新」统计的单元测试。
 *
 * 锁的是三条 MUST 的阻断条件（无软件清单、依赖有环、基线未同步）与「无变化也要进提测」：
 * 页面禁用按钮与接口拒绝写库都读这一份结论，任何一条判漏都会让不该提交的提测写进库里。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReleaseReadiness, summarizeChanges } from "../lib/releases/plan";
import type { SoftwareEntry } from "../lib/projects/softwareView";

function entry(
  packageName: string,
  upstreamNames: string[] = [],
  lastSubmittedCommit: string | null = null,
): SoftwareEntry {
  return { packageName, trackedBranch: "develop/eagle", upstreamNames, lastSubmittedCommit };
}

const SYNCED = { name: "eagle-1071", state: "synced" } as const;

test("清单为空时被阻断，并指出去哪里加包", () => {
  const readiness = evaluateReleaseReadiness({ baseline: SYNCED, entries: [] });

  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.blockers.map((blocker) => blocker.code),
    ["empty_software"],
  );
  assert.match(readiness.blockers[0].message, /软件清单/);
});

test("依赖有环时被阻断，提示里带出回路", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [entry("kwin", ["dde-dock"]), entry("dde-dock", ["kwin"])],
  });

  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.blockers.map((blocker) => blocker.code),
    ["dependency_cycle"],
  );
  assert.match(readiness.blockers[0].message, /kwin → dde-dock → kwin/);
  assert.match(readiness.blockers[0].message, /软件包管理/);
});

test("自依赖也算环，回路从阻断文案里读", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [entry("kwin", ["kwin"])],
  });

  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers[0].message, /kwin → kwin/);
});

test("结论里不再单列依赖环，环只通过阻断文案给出", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [entry("kwin", ["dde-dock"]), entry("dde-dock", ["kwin"])],
  });

  assert.deepEqual(Object.keys(readiness).sort(), [
    "blockers",
    "dependencyCount",
    "order",
    "packageCount",
    "ready",
  ]);
});

test("基线未同步、已消失、同步失败三种都被阻断，且原因各不相同", () => {
  const cases = [
    { state: "unsynced" as const, pattern: /还没有同步过/ },
    { state: "missing" as const, pattern: /已从 CRP 分支列表消失/ },
    { state: "failed" as const, pattern: /同步失败/ },
  ];

  for (const item of cases) {
    const readiness = evaluateReleaseReadiness({
      baseline: { name: "eagle-1071", state: item.state },
      entries: [entry("kwin")],
    });

    assert.equal(readiness.ready, false, item.state);
    assert.deepEqual(
      readiness.blockers.map((blocker) => blocker.code),
      ["baseline_unavailable"],
    );
    assert.match(readiness.blockers[0].message, item.pattern);
  }
});

test("只有「已同步」的基线放行", () => {
  const states = ["synced", "missing", "failed", "unsynced"] as const;
  const allowed = states.filter(
    (state) =>
      evaluateReleaseReadiness({
        baseline: { name: "eagle-1071", state },
        entries: [entry("kwin")],
      }).ready,
  );

  assert.deepEqual(allowed, ["synced"]);
});

test("三条阻断条件可以同时成立，一次全部报出来", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: { name: "eagle-1071", state: "unsynced" },
    entries: [],
  });

  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.blockers.map((blocker) => blocker.code),
    ["empty_software", "baseline_unavailable"],
  );
});

test("全部成立时放行，并给出上游在前的投递顺序", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [
      entry("dde-dock", ["dde-session-shell"]),
      entry("dde-session-shell", ["deepin-polkit-agent"]),
      entry("deepin-polkit-agent"),
    ],
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.order, ["deepin-polkit-agent", "dde-session-shell", "dde-dock"]);
  assert.equal(readiness.packageCount, 3);
  assert.equal(readiness.dependencyCount, 2);
});

test("清单外的上游不参与排序，也不计入依赖边", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [entry("dde-dock", ["kwin"])],
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.order, ["dde-dock"]);
  assert.equal(readiness.dependencyCount, 0);
});

test("「无变化」的软件包不阻断提交", () => {
  const readiness = evaluateReleaseReadiness({
    baseline: SYNCED,
    entries: [entry("kwin", [], "abc1234")],
  });

  assert.equal(readiness.ready, true);
});

test("统计「本次将提测 N 个软件，其中 M 个有更新」", () => {
  assert.deepEqual(summarizeChanges([{ changed: true }, { changed: false }]), {
    total: 2,
    changed: 1,
    summary: "本次将提测 2 个软件，其中 1 个有更新。",
  });
});

test("全部无变化时也照样统计总数", () => {
  assert.equal(
    summarizeChanges([{ changed: false }, { changed: false }, { changed: false }]).summary,
    "本次将提测 3 个软件，其中 0 个有更新。",
  );
});

test("空清单的统计是 0 个", () => {
  assert.deepEqual(summarizeChanges([]), {
    total: 0,
    changed: 0,
    summary: "本次将提测 0 个软件，其中 0 个有更新。",
  });
});
