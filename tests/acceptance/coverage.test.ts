/**
 * 用例集自检：`.agents/spec/design/test-cases.md` 与 `tests/acceptance/` 必须一一对应（MKACG-985）。
 *
 * 这一条不是「用例集里的某一条」，所以没有 `FUNC-` / `UI-` 之类的编号 —— 它检查的正是编号本身。
 * 用例集第八节的两条要求都由它兜住：
 *
 * - 「77 条一条不能少」：文档里有、实现里没有的编号会被列出来；
 * - 「出现无编号的测试或无用例的测试都算不合格」：写了文档里没有的编号、同一个编号写两次，都会被列出来。
 *
 * 实现是扫源码里的注册调用，不是跑用例：跳过的用例（`acceptanceTodo`）同样算「已注册」，
 * 于是「用 TODO 占位」这件事本身就是可核对的，而不是一句口头说明。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { readSpecCases } from "./support/catalog";

const GROUPS = ["func", "ui", "edge", "sec"] as const;

/** 注册调用的三种写法，后面紧跟的就是编号。 */
const REGISTRATION = /\bacceptance(?:Case|WithEnv|Todo)\(\s*"((?:FUNC|UI|EDGE|SEC)-\d{2})"/gu;

/** 分组目录下的用例文件。 */
function caseFiles(group: string): string[] {
  const directory = resolve(process.cwd(), "tests/acceptance", group);

  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(directory, name));
}

/** 源码里注册过的编号 → 出现过的文件，用来报「重复注册」。 */
function registrations(): Map<string, string[]> {
  const found = new Map<string, string[]>();

  for (const group of GROUPS) {
    for (const file of caseFiles(group)) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(REGISTRATION)) {
        const id = match[1];

        if (id === undefined) {
          continue;
        }

        const list = found.get(id) ?? [];
        list.push(relative(process.cwd(), file));
        found.set(id, list);
      }
    }
  }

  return found;
}

test("用例集自检：用例集里的每条编号都在 tests/acceptance 里注册过，且没有多余的编号", () => {
  const spec = readSpecCases();
  const registered = registrations();

  assert.equal(
    new Set(spec.map((item) => item.id)).size,
    spec.length,
    "用例集里出现了重复编号",
  );

  const missing = spec.map((item) => item.id).filter((id) => !registered.has(id));
  const unknown = [...registered.keys()].filter(
    (id) => !spec.some((item) => item.id === id),
  );
  const duplicated = [...registered.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => `${id}（${files.join("、")}）`);

  assert.deepEqual(missing, [], `用例集里有、实现里没有的编号：${missing.join("、")}`);
  assert.deepEqual(unknown, [], `tests/acceptance 里写了用例集没有的编号：${unknown.join("、")}`);
  assert.deepEqual(duplicated, [], `同一个编号注册了多次：${duplicated.join("；")}`);
});

test("用例集自检：分组数量与用例集一致（功能 34、界面 25、边界 10、权限 8）", () => {
  const spec = readSpecCases();
  const counted = new Map<string, number>();

  for (const item of spec) {
    counted.set(item.group, (counted.get(item.group) ?? 0) + 1);
  }

  assert.deepEqual(Object.fromEntries(counted), {
    FUNC: 34,
    UI: 25,
    EDGE: 10,
    SEC: 8,
  });
  assert.equal(spec.length, 77);
});
