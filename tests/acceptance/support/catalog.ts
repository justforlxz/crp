/**
 * 验收用例集（`.agents/spec/design/test-cases.md`）的唯一读取入口（MKACG-985）。
 *
 * 用例的编号与标题只有这一份：测试名由 `acceptanceCase(id, …)` 按这里的内容拼出来，
 * 所以文档改标题、测试名跟着改，不会出现「文档叫 A、测试叫 B」的漂移。
 * `coverage.test.ts` 再拿这份清单和实际注册的用例对一遍，缺一条就失败。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CaseGroup = "FUNC" | "UI" | "EDGE" | "SEC";

export type SpecCase = {
  id: string;
  group: CaseGroup;
  title: string;
};

/** 用例集文件，相对仓库根。 */
export const CASE_FILE = ".agents/spec/design/test-cases.md";

/**
 * 表格里的一行：`| FUNC-01 | 工作台统计口径 | 灌入 … | … |`。
 *
 * 只认「编号 + 标题」两列，后面的步骤与预期不参与比对 —— 那是给人看的，不是断言。
 */
const CASE_ROW = /^\|\s*(FUNC|UI|EDGE|SEC)-(\d{2})\s*\|\s*([^|]+?)\s*\|/gmu;

let cache: { root: string; cases: SpecCase[] } | null = null;

/** 读出用例集里的全部编号与标题，按文档顺序。 */
export function readSpecCases(root: string = process.cwd()): SpecCase[] {
  if (cache !== null && cache.root === root) {
    return cache.cases;
  }

  const text = readFileSync(resolve(root, CASE_FILE), "utf8");
  const cases: SpecCase[] = [];

  for (const match of text.matchAll(CASE_ROW)) {
    const [, group, number, title] = match;

    if (group === undefined || number === undefined || title === undefined) {
      continue;
    }

    cases.push({
      id: `${group}-${number}`,
      group: group as CaseGroup,
      title,
    });
  }

  cache = { root, cases };

  return cases;
}

/** 按编号取一条用例；编号不在用例集里直接抛错，免得写错编号还没人发现。 */
export function caseById(id: string, root: string = process.cwd()): SpecCase {
  const found = readSpecCases(root).find((item) => item.id === id);

  if (found === undefined) {
    throw new Error(
      `用例集里没有编号 ${id}（${CASE_FILE}）。编号必须与文档完全一致，不能自编。`,
    );
  }

  return found;
}
