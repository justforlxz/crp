/**
 * 投递用的架构集合：把 Shuttle 的架构列表变成 CRP 的 `Arches` 字符串。
 *
 * 期望值来自 `lib/integrations/crp/FINDINGS.md` 第十二节的实测：
 *
 * | 请求里的 Arches | CRP BuildState |
 * | `amd64;sw_64`、`amd64;loongarch64`、`amd64;i386`、`amd64;mips64el` | 进入构建 |
 * | `amd64;sw64`、`amd64;loong64` | APPLY_FAILED |
 *
 * 所以这里锁两件事：名字必须原样发（不改名），非 CPU 项必须去掉。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { toCrpArches, toCrpArchList } from "../lib/integrations/crp";

/** `eagle-1071` 的 release-candidate 仓库实测返回的架构列表。 */
const EAGLE_1071_ARCHES = [
  "loongarch64",
  "source",
  "sw_64",
  "arm64",
  "i386",
  "amd64",
  "mips64el",
];

test("AC1 去掉 source、去重、顺序稳定：eagle-1071 的实测列表", () => {
  assert.equal(
    toCrpArches(EAGLE_1071_ARCHES),
    "amd64;arm64;i386;loongarch64;mips64el;sw_64",
  );
});

test("AC1 架构名原样发：sw_64 不发成 sw64，loongarch64 不发成 loong64", () => {
  const arches = toCrpArchList(EAGLE_1071_ARCHES);

  assert.ok(arches.includes("sw_64"), "必须保留 Shuttle 的写法 sw_64");
  assert.ok(arches.includes("loongarch64"), "必须保留 Shuttle 的写法 loongarch64");
  assert.ok(!arches.includes("sw64"), "不能出现 CRP 会 APPLY_FAILED 的 sw64");
  assert.ok(!arches.includes("loong64"), "不能出现 CRP 会 APPLY_FAILED 的 loong64");
});

test("AC1 输出里没有 source，也没有重复项", () => {
  const arches = toCrpArchList(EAGLE_1071_ARCHES);

  assert.ok(!arches.includes("source"));
  assert.equal(new Set(arches).size, arches.length);
});

test("AC1 顺序只由集合决定：打乱输入顺序，输出不变", () => {
  const shuffled = ["mips64el", "amd64", "sw_64", "i386", "arm64", "source", "loongarch64"];

  assert.equal(toCrpArches(shuffled), toCrpArches(EAGLE_1071_ARCHES));
});

test("重复项只保留一个", () => {
  assert.deepEqual(toCrpArchList(["amd64", "amd64", "arm64", "amd64"]), ["amd64", "arm64"]);
});

test("空白项与前后空格：空项丢掉，其余去掉首尾空格", () => {
  assert.deepEqual(toCrpArchList([" amd64 ", "", "  ", "Source", "arm64"]), ["amd64", "arm64"]);
});

test("没有可用的 CPU 架构时返回空字符串，交给调用方判错", () => {
  assert.equal(toCrpArches([]), "");
  assert.equal(toCrpArches(["source"]), "");
  assert.deepEqual(toCrpArchList(["source", "SOURCE"]), []);
});
