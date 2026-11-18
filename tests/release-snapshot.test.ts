/**
 * 提测快照组装规则的单元测试。
 *
 * 锁的是三个版本号的来源与「自定义 Tag 只覆盖提测版本」这条 MUST：
 *
 * - 代码版本永远来自所选 Commit 的 `debian/changelog`，不因设置了 Tag 而改变（AC3）；
 * - 仓库版本永远来自基线缓存，与 Tag 无关；
 * - 提测版本 = 自定义 Tag（填了的话）否则代码版本。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildSnapshotPlan } from "../lib/releases/snapshot";

const SHA = "4f0b1d2e8c9a7b6d5e4f3a2b1c0d9e8f7a6b5c4d";

function input(overrides: Partial<Parameters<typeof buildSnapshotPlan>[0]> = {}) {
  return {
    packageName: "kwin",
    branch: "develop/eagle",
    commitSha: SHA,
    codeVersion: "5.27.11.1-1",
    repoVersion: "5.27.11.0-1",
    customTag: null,
    lastSubmittedCommit: null,
    ...overrides,
  };
}

test("没填自定义 Tag 时，提测版本等于代码版本", () => {
  const plan = buildSnapshotPlan(input());

  assert.equal(plan.releaseVersion, "5.27.11.1-1");
  assert.equal(plan.codeVersion, "5.27.11.1-1");
  assert.equal(plan.repoVersion, "5.27.11.0-1");
  assert.equal(plan.attempt, 1);
});

test("填了自定义 Tag 时，提测版本等于自定义值，代码版本保持 changelog 解析值（AC3）", () => {
  const plan = buildSnapshotPlan(input({ customTag: "5.27.12.0" }));

  assert.equal(plan.releaseVersion, "5.27.12.0");
  assert.equal(plan.codeVersion, "5.27.11.1-1");
  assert.equal(plan.repoVersion, "5.27.11.0-1");
});

test("自定义 Tag 只有空白字符时按没填处理", () => {
  assert.equal(buildSnapshotPlan(input({ customTag: "   " })).releaseVersion, "5.27.11.1-1");
});

test("自定义 Tag 去首尾空白后入库", () => {
  assert.equal(buildSnapshotPlan(input({ customTag: " 5.27.12.0 " })).releaseVersion, "5.27.12.0");
});

test("基线里查不到这个包时仓库版本为空，提测版本不受影响", () => {
  const plan = buildSnapshotPlan(input({ repoVersion: null }));

  assert.equal(plan.repoVersion, null);
  assert.equal(plan.releaseVersion, "5.27.11.1-1");
});

test("Commit 与上次提测相同即「无变化」", () => {
  assert.equal(buildSnapshotPlan(input({ lastSubmittedCommit: SHA })).changed, false);
});

test("Commit 与上次提测不同即「有更新」", () => {
  assert.equal(
    buildSnapshotPlan(input({ lastSubmittedCommit: "0000000000000000000000000000000000000000" }))
      .changed,
    true,
  );
});

test("还没提测过的包算「有更新」", () => {
  assert.equal(buildSnapshotPlan(input({ lastSubmittedCommit: null })).changed, true);
});
