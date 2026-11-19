/**
 * Shuttle 状态映射的单测。
 *
 * 锁住的是「什么算构建成功、什么算失败、什么算还没结论」这三件事，因为它们直接决定
 * 下游包能不能投（`lib/build/chain.ts` 只看快照状态）。
 *
 * 映射表里只写实测见过的值（`lib/integrations/shuttle/FINDINGS.md`）：
 * 任务状态见过 `UPLOAD_GIVEUP`，作业状态见过 `BUILD_OK`、`FAILED`。没见过的值一律算「还在构建」，
 * 这几条断言就是防止有人日后把「未知当失败」改回来 —— 那会让下游被错误阻断。
 */

import assert from "node:assert/strict";
import test from "node:test";

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

test("终止类状态映射为 canceled", () => {
  for (const state of ["TERMINATED", "CANCELLED", "KILLED"]) {
    assert.equal(mapShuttleState(state), "canceled", state);
  }
});

test("没见过的状态与空状态都算「还在构建」，不当成失败", () => {
  for (const state of ["", "APPLYING", "WAITING_FOR_SLAVE", "某天新加的状态"]) {
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
