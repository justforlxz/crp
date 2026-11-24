/**
 * 界面组：模块门禁（UI-01）。
 *
 * 这一条就是 `pnpm check:modules` 的判定，只是搬进用例集里，让「界面没跑偏」这件事
 * 在 `pnpm test:acceptance:ui` 的报告里也有一行。模块清单只从
 * `.agents/spec/design/modules.json` 读，比对逻辑复用 `scripts/check-modules.ts`，
 * 测试里没有第二份清单（AC4）。
 *
 * 它不需要浏览器，但用例集把它归在界面组 —— 所以放在这里，由界面组命令一起跑。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  classSelectorsOfCss,
  collectSourceFiles,
  compareModules,
  type SourceFile,
} from "../../../scripts/check-modules";
import { acceptanceCase } from "../support/case";
import { loadModuleSpec, MODULE_FILE, pageNames, routeOf } from "../support/modules";
import { expectEqual, expectTrue } from "../support/report";

acceptanceCase("UI-01", async () => {
  const root = process.cwd();
  const spec = loadModuleSpec(root);
  const sources: Record<string, SourceFile[]> = {};

  for (const page of pageNames(spec)) {
    sources[page] = collectSourceFiles(root, spec.pages[page]?.sources ?? []).map((path) => ({
      path,
      content: readFileSync(resolve(root, path), "utf8"),
    }));
  }

  const styles = readFileSync(resolve(root, "app/globals.css"), "utf8");
  const report = compareModules(spec, sources, styles);

  expectTrue(
    "UI-01",
    "模块清单里的页面条目数（`modules.json` 现在是 11 条）",
    `11 个页面条目，实际 ${String(report.pages.length)} 个`,
    report.pages.length === 11,
  );

  expectEqual(
    "UI-01",
    `缺失模块的页面（清单来源 ${MODULE_FILE}）`,
    [],
    report.pages
      .filter((page) => page.missing.length > 0)
      .map((page) => `${routeOf(spec, page.name)}（${page.name}）缺：${page.missing.join(" ")}`),
  );

  expectEqual("UI-01", "全局模块缺失", [], report.globalMissing);

  // 样式表另算一次：页面用上了但类选择器没写，样式不会生效，界面上看不出「缺」。
  const styleTokens = classSelectorsOfCss(styles);
  const styleMissing = report.styleMissing.filter((module) => !styleTokens.has(module.replace(/^\./u, "")));

  expectEqual("UI-01", "样式表缺失（app/globals.css 里没有类选择器规则）", [], styleMissing);
});
