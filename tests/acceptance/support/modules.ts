/**
 * 模块清单的唯一来源（MKACG-985）。
 *
 * 用例集与 AC4 都要求「测试代码里不出现第二份模块清单」：模块名一律从
 * `.agents/spec/design/modules.json` 读，比对逻辑复用 `scripts/check-modules.ts` 里
 * 那一套（只认 `className` 上下文、只认规则头里的类选择器），不另写一份。
 *
 * 这样做的直接后果：`modules.json` 加一页，验收用例的页面数跟着变，测试代码不用改。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ModuleSpec } from "../../../scripts/check-modules";

/** 清单文件，相对仓库根。 */
export const MODULE_FILE = ".agents/spec/design/modules.json";

/** 读清单。文件读不到就抛错，不返回空清单 —— 空清单会让「缺失：无」变成假通过。 */
export function loadModuleSpec(root: string = process.cwd()): ModuleSpec {
  return JSON.parse(readFileSync(resolve(root, MODULE_FILE), "utf8")) as ModuleSpec;
}

/** 清单里的页面条目名，按文件里的顺序。 */
export function pageNames(spec: ModuleSpec): string[] {
  return Object.keys(spec.pages);
}

/** 某一页的路由，报告里给人看。 */
export function routeOf(spec: ModuleSpec, page: string): string {
  return spec.pages[page]?.route ?? page;
}
