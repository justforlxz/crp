/**
 * L1 静态结构检查（A20）。
 *
 * 只读源码，不需要数据库、浏览器或跑起来的服务，所以它是 `pnpm test:style` 的第一步：结构先过了，
 * 再花时间起服务、抓基线。
 *
 * 四条判据来自 A19 收敛后的约定，明细见 `docs/STYLE-VERIFICATION.md`：
 *
 * 1. 所有 `app/**\/page.tsx` 经 `PageShell` 渲染；
 * 2. 没有裸 `<table>`：每个 `<table>` 都要带 `className="data-table"`，横向滚动容器由 L2 的
 *    `*.table-scroll` 锚点覆盖；
 * 3. 没有新增内联 `style={{`；
 * 4. `app/globals.css` 的规则数不低于基线；
 * 5. `:root` 里的设计变量值不变。
 *
 * 第 4、5 条的基线都写在 `tests/visual/baseline/lint.json`，与页面基线一起由 `--update` 刷新。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { compareCssVariables, type Finding } from "./compare";

export type LintCheck = {
  /** 这一条过没过。 */
  ok: boolean;
  /** 报告里的一行说明：过了写结论，没过写命中的文件与位置。 */
  description: string;
};

/**
 * 去掉 CSS 注释，保留其余内容（含引号里的文本）。
 *
 * 读设计变量要用它：变量的值本身就可能是带引号的字体名，把引号内容删掉会把
 * `ui-monospace, …, "Liberation Mono", monospace` 比成 `ui-monospace, …, , monospace`，
 * 改动落在引号里就看不出来了。
 */
export function stripCssComments(css: string): string {
  let output = "";
  let index = 0;

  while (index < css.length) {
    const char = css[index];

    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

/**
 * 去掉 CSS 注释与引号里的内容，只留结构。
 *
 * 计数用它：`{` 的个数就是声明块个数，注释里的花括号与 `content: "{"` 这类字面量不该算进来。
 * 读变量值不能用它 —— 那会把引号里的内容一起删掉，见 `stripCssComments()`。
 */
export function stripCssNoise(css: string): string {
  let output = "";
  let index = 0;

  while (index < css.length) {
    const char = css[index];

    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      index += 1;

      while (index < css.length && css[index] !== char) {
        // 反斜杠转义：跳过下一个字符，避免 `\"` 提前结束字面量。
        index += css[index] === "\\" ? 2 : 1;
      }

      index += 1;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

/** `app/globals.css` 的规则数：去掉注释与字符串之后 `{` 的个数。 */
export function countCssRuleBlocks(css: string): number {
  return stripCssNoise(css).split("{").length - 1;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** 按分隔符切分，但不切引号里的内容（`content: "a;b"` 里的分号不算分隔符）。 */
function splitOutsideStrings(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;

    if (quote !== null) {
      current += char;

      if (char === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === separator) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);

  return parts;
}

/**
 * `:root` 里的设计变量：名字 → 值。顺序按文件里的出现顺序。
 *
 * 值按原始写法保留（含引号与空格）：带引号的字体名也是样式的一部分，改掉它必须能被看到
 * —— 所以这里只去注释，不碰字符串；分号也只在引号外才算一条声明的结束。
 * 变量名里不会有引号，所以名字与值在第一处 `:` 处切开就够。
 */
export function readCssVariables(css: string): Record<string, string> {
  const rootBlock = /:root\s*\{([^}]*)\}/u.exec(stripCssComments(css));

  if (rootBlock === null) {
    return {};
  }

  const variables: Record<string, string> = {};

  for (const declaration of splitOutsideStrings(rootBlock[1] ?? "", ";")) {
    const separator = declaration.indexOf(":");

    if (separator === -1) {
      continue;
    }

    const name = declaration.slice(0, separator).trim();

    if (!name.startsWith("--")) {
      continue;
    }

    variables[name] = declaration.slice(separator + 1).trim();
  }

  return variables;
}

export type SourceHit = { line: number; text: string };

/**
 * 找出没带表模块类名的 `<table>` 开标签。
 *
 * 认两个类名：`.data-table`（v1 的名字，还没迁完的页面在用）与 `table.grid`（`design.md`
 * 第七节的表格模块，v2 页面都用它）。两个都认，界面重做期间新旧页面混着也判得对。
 */
export function findBareTables(source: string): SourceHit[] {
  const hits: SourceHit[] = [];
  const pattern = /<table\b([^>]*)>/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const attributes = match[1] ?? "";

    // 类名按 token 比对：`className="grid wide"` 也算带了表格模块，不能因为多了个类就判成裸表。
    const className = /className\s*=\s*"([^"]*)"/u.exec(attributes);

    if (className !== null) {
      const tokens = (className[1] ?? "").split(/\s+/);

      if (tokens.includes("data-table") || tokens.includes("grid")) {
        continue;
      }
    }

    hits.push({ line: lineOf(source, match.index), text: match[0] });
  }

  return hits;
}

/**
 * 找出内联 `style={{` 的位置。白名单目前为空：A19 之后全站只有一个样式来源。
 *
 * 等号两边允许空格：`style = {{` 与 `style={{` 是同一个意思，漏掉就等于放行。
 */
export function findInlineStyles(source: string): SourceHit[] {
  const hits: SourceHit[] = [];
  const pattern = /style\s*=\s*\{\{/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    hits.push({ line: lineOf(source, match.index), text: "style={{ … }}" });
  }

  return hits;
}

/** 页面是否经 `PageShell` 渲染：既要引进来，也要真的用上。 */
export function usesPageShell(source: string): boolean {
  return /from\s+"@\/components\/page-shell"/u.test(source) && /<PageShell\b/u.test(source);
}

/** 递归列出某个目录下的文件，返回相对仓库根的路径（统一用 `/`）。 */
export function listFiles(root: string, directory: string, extension: string): string[] {
  const absolute = join(root, directory);

  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => `${directory}/${entry}`)
    .sort();
}

/**
 * 跑完四条静态检查。
 *
 * `globalsRuleBaseline` 为 `null` 表示基线还不存在（没跑过 `--update`），这一条按不通过处理并
 * 说明该跑什么命令 —— 静默放行会让规则数基线永远停在“没有”。
 */
export function runLint(input: {
  root: string;
  globalsRuleBaseline: number | null;
  /** 设计变量基线；`null` 表示还没建立。 */
  variableBaseline: Record<string, string> | null;
  /** 写基线模式：规则数与变量两条只报当前值，不算失败（旧的基线马上会被重写）。 */
  update: boolean;
}): {
  checks: LintCheck[];
  globalsRuleCount: number;
  variables: Record<string, string>;
  variableFindings: Finding[];
} {
  const { root, globalsRuleBaseline, variableBaseline, update } = input;
  const checks: LintCheck[] = [];

  const pageFiles = listFiles(root, "app", "page.tsx");
  const pagesWithoutShell = pageFiles.filter(
    (file) => !usesPageShell(readFileSync(join(root, file), "utf8")),
  );

  checks.push({
    ok: pagesWithoutShell.length === 0,
    description:
      pagesWithoutShell.length === 0
        ? `${pageFiles.length} 个 page.tsx 全部经 PageShell 渲染`
        : `有 ${pagesWithoutShell.length} 个 page.tsx 没经 PageShell 渲染：${pagesWithoutShell.join("、")}`,
  });

  const sourceFiles = [
    ...listFiles(root, "app", ".tsx"),
    ...listFiles(root, "components", ".tsx"),
  ];
  const bareTables = sourceFiles.flatMap((file) =>
    findBareTables(readFileSync(join(root, file), "utf8")).map(
      (hit) => `${file}:${hit.line} ${hit.text}`,
    ),
  );

  checks.push({
    ok: bareTables.length === 0,
    description:
      bareTables.length === 0
        ? "没有裸 <table>：所有表格都带 .data-table"
        : `有 ${bareTables.length} 处裸 <table>（缺少 className="data-table"）：${bareTables.join("；")}`,
  });

  const inlineStyles = sourceFiles.flatMap((file) =>
    findInlineStyles(readFileSync(join(root, file), "utf8")).map(
      (hit) => `${file}:${hit.line}`,
    ),
  );

  checks.push({
    ok: inlineStyles.length === 0,
    description:
      inlineStyles.length === 0
        ? "没有新增内联 style：样式来源只有 app/globals.css"
        : `有 ${inlineStyles.length} 处内联 style（样式来源不再唯一）：${inlineStyles.join("、")}`,
  });

  const globalsCss = readFileSync(join(root, "app/globals.css"), "utf8");
  const globalsRuleCount = countCssRuleBlocks(globalsCss);
  const variables = readCssVariables(globalsCss);

  checks.push({
    ok: update || (globalsRuleBaseline !== null && globalsRuleCount >= globalsRuleBaseline),
    description:
      update
        ? `app/globals.css 规则数 ${globalsRuleCount}（随 --update 写入基线）`
        : globalsRuleBaseline === null
          ? "app/globals.css 的规则数还没有基线，先跑 pnpm test:style --update"
        : globalsRuleCount >= globalsRuleBaseline
          ? `app/globals.css 规则数 ${globalsRuleCount} ≥ 基线 ${globalsRuleBaseline}`
          : `app/globals.css 规则数 ${globalsRuleCount} 少于基线 ${globalsRuleBaseline}，有规则被删掉了`,
  });

  const variableFindings =
    variableBaseline === null
      ? []
      : compareCssVariables({
          file: "app/globals.css",
          expected: variableBaseline,
          actual: variables,
        });

  checks.push({
    ok: update || variableFindings.length === 0,
    description: update
      ? `app/globals.css 设计变量 ${String(Object.keys(variables).length)} 个（随 --update 写入基线）`
      : variableBaseline === null
        ? "app/globals.css 的设计变量还没有基线，先跑 pnpm test:style --update"
        : variableFindings.length === 0
          ? `app/globals.css 设计变量 ${String(Object.keys(variables).length)} 个，与基线一致`
          : `app/globals.css 有 ${String(variableFindings.length)} 个设计变量与基线不同`,
  });

  return { checks, globalsRuleCount, variables, variableFindings };
}
