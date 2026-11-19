/**
 * 从 CRP 导入提测时那张映射表的单测：纯函数，不连数据库、不连外部接口。
 *
 * 锁住三条：
 *
 * - 实测见过的 CRP 构建状态各归各档（`UPLOAD_OK` → success、`UPLOAD_CRP` → building、
 *   `UPLOAD_GIVEUP` → failed）；
 * - 没见过或没有状态一律按 `pending`，并且「没见过」要在预览里标出来；
 * - 整条提测的状态由每个包的状态推出，判定顺序是「全部成功 → 有人在跑 → 有人没开始 → 失败」。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mapCrpBuildState, releaseStatusFromSnapshots } from "../lib/releases/import-map";

test("实测见过的 CRP 构建状态各归各档", () => {
  assert.equal(mapCrpBuildState("UPLOAD_OK").status, "success");
  assert.equal(mapCrpBuildState("UPLOAD_CRP").status, "building");
  assert.equal(mapCrpBuildState("APPLYING").status, "building");
  assert.equal(mapCrpBuildState("UPLOAD_GIVEUP").status, "failed");

  for (const state of ["UPLOAD_OK", "UPLOAD_CRP", "APPLYING", "UPLOAD_GIVEUP"]) {
    const mapped = mapCrpBuildState(state);
    assert.equal(mapped.known, true, `${state} 应该在映射表里`);
    assert.equal(mapped.note, null, `${state} 是清楚的状态，不需要额外说明`);
  }
});

test("大小写与空白不影响映射：CRP 与 Shuttle 的叫法都能认", () => {
  assert.equal(mapCrpBuildState(" upload_ok ").status, "success");
  assert.equal(mapCrpBuildState("Upload_Crp").status, "building");
  assert.equal(mapCrpBuildState("BUILD_OK").status, "success");
  assert.equal(mapCrpBuildState("BUILD_FAILED").status, "failed");
});

test("没有状态与没见过的状态都按待投递处理，但只有后者要在预览里标红", () => {
  for (const empty of ["", null, undefined, "UNKNOWN"]) {
    const mapped = mapCrpBuildState(empty);
    assert.equal(mapped.status, "pending", `${String(empty)} 按待投递处理`);
    assert.equal(mapped.known, true, `${String(empty)} 不算没见过`);
  }

  const unknown = mapCrpBuildState("SOMETHING_NEW");

  assert.equal(unknown.status, "pending");
  assert.equal(unknown.known, false);
  assert.match(unknown.note as string, /没见过的构建状态/);
  assert.match(unknown.note as string, /SOMETHING_NEW/);
});

test("绝不把没见过的状态猜成成功", () => {
  for (const state of ["SOMETHING_NEW", "UPLOAD_PENDING", "RETRYING", "???"]) {
    assert.notEqual(mapCrpBuildState(state).status, "success", `${state} 不该被当成成功`);
  }
});

test("整条提测的状态：全部成功才是 success", () => {
  assert.equal(releaseStatusFromSnapshots(["success", "success"]), "success");
});

test("整条提测的状态：还有包在跑就是 building，不提前判失败", () => {
  assert.equal(releaseStatusFromSnapshots(["success", "building"]), "building");
  assert.equal(releaseStatusFromSnapshots(["failed", "building"]), "building");
});

test("整条提测的状态：还有包没开始就是 pending，即便已经有包成功", () => {
  assert.equal(releaseStatusFromSnapshots(["success", "pending"]), "pending");
});

test("整条提测的状态：全部跑完才下失败的结论，有成功的是 partial_failure", () => {
  assert.equal(releaseStatusFromSnapshots(["success", "failed"]), "partial_failure");
  assert.equal(releaseStatusFromSnapshots(["failed", "failed"]), "failed");
});

test("没有包时给 pending，不抛错", () => {
  assert.equal(releaseStatusFromSnapshots([]), "pending");
});
