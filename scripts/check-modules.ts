/**
 * 模块对照（MKACG-966 / MKACG-969）：拿 `.agents/spec/design/modules.json` 的清单，逐页检查实现里
 * 还缺哪些原型模块，把「逐页数 class」变成一条命令。
 *
 * 用法：
 *
 *   pnpm check:modules            # 有缺失 → 退出码 1，并逐页列出缺失清单
 *   pnpm check:modules --report   # 只报告，退出码恒为 0（CI 暂用这一档）
 *   pnpm check:modules --help     # 打印上面两行的差别
 *
 * 两处判定，缺一即算缺失：
 *
 * 1. **页面用法**：只认 `className` 上下文里的字符串。`className="a b"`、`className={`a ${x}`}`、
 *    `className={ok ? "a" : "b"}`、`clsx("a", ...)` 里的 class 都算；注释、变量名、
 *    `id="a"` / `data-x="a"` 这类别的属性、正文文字都不算。全文搜字符串会把
 *    `listHref(filters)` 里的 `filters` 当成 `.filters` 模块已具备，检查立刻失去意义，
 *    所以这里先剥注释，再只从 `className` 右侧取值。
 * 2. **样式表**（MKACG-969）：清单里的每个模块都要在 `app/globals.css` 里有类选择器规则。
 *    同样不是全文搜 —— 只读规则头（`{` 之前的那段），声明块、注释、`@media` 的条件文本都不算，
 *    否则 `content: ".tip"` 这种声明就能让缺失的模块「已具备」。
 *
 * 模块名一律来自 `modules.json`，脚本里不写第二份清单。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 一页的原型模块清单。`route` 只用于输出，`sources` 是仓库内的相对路径。 */
export type PageSpec = {
  route: string;
  sources: string[];
  modules: string[];
};

/** `modules.json` 的结构。 */
export type ModuleSpec = {
  note?: string;
  global: string[];
  pages: Record<string, PageSpec>;
};

/** 一个待扫描的文件：路径用于报错定位，内容用于提取 class。 */
export type SourceFile = {
  path: string;
  content: string;
};

/** 一页的比对结果。`missing` / `present` 都按 `modules.json` 的顺序排列。 */
export type PageReport = {
  name: string;
  route: string;
  missing: string[];
  present: string[];
};

/** 整份报告。 */
export type ModuleReport = {
  pages: PageReport[];
  globalMissing: string[];
  globalPresent: string[];
  /** 样式表里没有类选择器规则的模块（按 `modules.json` 的顺序）。 */
  styleMissing: string[];
  stylePresent: string[];
  /** 缺模块的页数。 */
  pagesWithMissing: number;
  /** 页面模块缺失总数（不含全局与样式表）。 */
  pageMissingTotal: number;
};

const SCAN_ROOT = process.cwd();
const SPEC_FILE = ".agents/spec/design/modules.json";

/** 全站唯一的样式表；模块的类选择器规则必须写在这里。 */
const STYLE_FILE = "app/globals.css";

/** 只扫 TSX：服务端组件与表单都在 `.tsx` 里，`.ts` 里没有 JSX 属性可认。 */
const SOURCE_SUFFIX = ".tsx";

const CLASS_NAME = /(?<![A-Za-z0-9_$])className(?![A-Za-z0-9_$])/g;

/**
 * 跳过一段普通字符串字面量，返回闭引号之后的下标。
 *
 * 带反斜杠的转义整体跳过，否则 `"a\"b"` 会在中间那个引号上提前收尾。
 */
function skipString(source: string, index: number): number {
  const quote = source[index] as string;
  let cursor = index + 1;

  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }

    if (source[cursor] === quote) {
      return cursor + 1;
    }

    cursor += 1;
  }

  return source.length;
}

/**
 * 跳过一段模板字面量（含 `${}` 里的表达式与嵌套模板），返回闭反引号之后的下标。
 */
function skipTemplate(source: string, index: number): number {
  let cursor = index + 1;

  while (cursor < source.length) {
    const char = source[cursor];

    if (char === "\\") {
      cursor += 2;
      continue;
    }

    if (char === "`") {
      return cursor + 1;
    }

    if (char === "$" && source[cursor + 1] === "{") {
      cursor = skipBraces(source, cursor + 1);
      continue;
    }

    cursor += 1;
  }

  return source.length;
}

/**
 * 跳过一段成对花括号，返回闭 `}` 之后的下标。
 *
 * 字符串与模板先整体跳过，里面的花括号不算嵌套层级 —— `className={`a ${b ? "}" : ""}`}`
 * 才不会被提前收尾。
 */
function skipBraces(source: string, index: number): number {
  let depth = 0;
  let cursor = index;

  while (cursor < source.length) {
    const char = source[cursor] as string;

    if (char === '"' || char === "'") {
      cursor = skipString(source, cursor);
      continue;
    }

    if (char === "`") {
      cursor = skipTemplate(source, cursor);
      continue;
    }

    if (char === "{") {
      depth += 1;
      cursor += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      cursor += 1;

      if (depth === 0) {
        return cursor;
      }

      continue;
    }

    cursor += 1;
  }

  return source.length;
}

/**
 * 把注释换成等长空白，保留换行，其余内容原样留下。
 *
 * 注释里的 `className="tip"` 不是代码。这个函数不认正则字面量里的引号 —— 本仓库的页面
 * 组件不写带引号的正则，真遇到时宁可多认一个字符串，也不切开真正的代码。
 */
export function stripComments(source: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor] as string;

    if (char === '"' || char === "'") {
      const end = skipString(source, cursor);
      output += source.slice(cursor, end);
      cursor = end;
      continue;
    }

    if (char === "`") {
      const end = skipTemplate(source, cursor);
      output += source.slice(cursor, end);
      cursor = end;
      continue;
    }

    if (char === "/" && source[cursor + 1] === "/") {
      const end = source.indexOf("\n", cursor);
      const stop = end === -1 ? source.length : end;
      output += " ".repeat(stop - cursor);
      cursor = stop;
      continue;
    }

    if (char === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += source.slice(cursor, stop).replace(/[^\n]/g, " ");
      cursor = stop;
      continue;
    }

    output += char;
    cursor += 1;
  }

  return output;
}

/** 按空白切分一个 class 值，丢掉空片段。 */
function splitClassTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token !== "");
}

/**
 * 取出模板字面量里的 class token：`a ${x} b` → `["a", "b"]`，`${ok ? "c" : ""}` 里的
 * `"c"` 也算。
 *
 * 静态片段直接切分；插值里只有字符串字面量与嵌套模板的静态片段算数，变量名不算 ——
 * `className={`item ${active}`}` 里的 `active` 是变量，不是 class。
 */
function templateTokens(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let cursor = 0;

  while (cursor < body.length) {
    const char = body[cursor];

    if (char === "\\") {
      current += body.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }

    if (char === "$" && body[cursor + 1] === "{") {
      tokens.push(...splitClassTokens(current));
      current = "";

      const end = skipBraces(body, cursor + 1);
      tokens.push(...expressionTokens(body.slice(cursor + 2, end - 1)));
      cursor = end;
      continue;
    }

    current += char;
    cursor += 1;
  }

  tokens.push(...splitClassTokens(current));

  return tokens;
}

/**
 * 从一个 `className` 表达式的源码里取出 class token。
 *
 * 表达式里只认字符串字面量与模板字面量的静态片段：三元的两支都算（class 存在即已具备），
 * `clsx("a", x && "b")` 的参数也算，`styles.tip` 这类成员访问不算 —— 真实的 class 名不在
 * 这里，凭空猜会制造假通过。
 */
function expressionTokens(expression: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const char = expression[cursor] as string;

    if (char === '"' || char === "'") {
      const end = skipString(expression, cursor);
      tokens.push(...splitClassTokens(expression.slice(cursor + 1, end - 1)));
      cursor = end;
      continue;
    }

    if (char === "`") {
      const end = skipTemplate(expression, cursor);

      tokens.push(...templateTokens(expression.slice(cursor + 1, end - 1)));

      cursor = end;
      continue;
    }

    cursor += 1;
  }

  return tokens;
}

/**
 * 收集一份源码里 `className` 上下文用到的 class token。
 *
 * 认四种写法：`className="a b"`、`className={`a ${x}`}`、`className={cond ? "a" : "b"}`、
 * `className={clsx("a", ...)}`；对象字面量里的 `className: "a"` 同样算。
 * 别的属性、变量名、注释、正文文字一概不算。
 */
export function classTokensOfSource(source: string): Set<string> {
  const tokens = new Set<string>();
  const code = stripComments(source);

  for (const match of code.matchAll(CLASS_NAME)) {
    let cursor = match.index + match[0].length;

    while (code[cursor] === " " || code[cursor] === "\t" || code[cursor] === "\n") {
      cursor += 1;
    }

    if (code[cursor] !== "=" && code[cursor] !== ":") {
      // 解构、成员访问之类：`const { className } = props`
      continue;
    }

    cursor += 1;

    while (code[cursor] === " " || code[cursor] === "\t" || code[cursor] === "\n") {
      cursor += 1;
    }

    const char = code[cursor];

    if (char === '"' || char === "'") {
      const end = skipString(code, cursor);

      for (const token of splitClassTokens(code.slice(cursor + 1, end - 1))) {
        tokens.add(token);
      }

      continue;
    }

    if (char === "`") {
      const end = skipTemplate(code, cursor);

      for (const token of templateTokens(code.slice(cursor + 1, end - 1))) {
        tokens.add(token);
      }

      continue;
    }

    if (char === "{") {
      const end = skipBraces(code, cursor);

      for (const token of expressionTokens(code.slice(cursor + 1, end - 1))) {
        tokens.add(token);
      }
    }
  }

  return tokens;
}

/**
 * 把 CSS 的 `/* … *\/` 换成等长空白，保留换行，其余原样留下。
 *
 * 只处理块注释：CSS 没有行注释，`url(https://…)` 里的 `//` 不是注释，套用 JS 那套规则会把
 * 后面的代码一起吃掉。
 */
export function stripCssComments(css: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < css.length) {
    if (css[cursor] === "/" && css[cursor + 1] === "*") {
      const end = css.indexOf("*/", cursor + 2);
      const stop = end === -1 ? css.length : end + 2;
      output += css.slice(cursor, stop).replace(/[^\n]/g, " ");
      cursor = stop;
      continue;
    }

    output += css[cursor];
    cursor += 1;
  }

  return output;
}

/**
 * 从 `{` 出发找到与它配对的 `}` 之后的下标。
 *
 * 字符串整体跳过：`content: "}"` 里的花括号不算嵌套层级，否则块会提前收尾。
 */
function skipBlock(code: string, index: number): number {
  let depth = 0;
  let cursor = index;

  while (cursor < code.length) {
    const char = code[cursor] as string;

    if (char === '"' || char === "'") {
      cursor = skipString(code, cursor);
      continue;
    }

    if (char === "{") {
      depth += 1;
      cursor += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      cursor += 1;

      if (depth === 0) {
        return cursor;
      }

      continue;
    }

    cursor += 1;
  }

  return code.length;
}

/**
 * 块级 at-rule：里面的内容是规则，要进去看选择器。
 *
 * 其余 at-rule（`@font-face`、`@keyframes`、`@property`）里的「规则头」不是选择器，
 * 例如 `from` / `50%` 这种关键帧名字，进去取会凭空多出类名。
 */
const NESTED_AT_RULE = /^@(?:media|supports|layer|container|document|scope)\b/iu;

/**
 * 收集样式表里所有规则的选择器文本。
 *
 * 只认「规则头」：从上一个 `}` 或 `;` 之后到 `{` 之前的那段文本。声明块整体跳过，所以
 * `content: ".tip"`、`background: url(.tip)` 这类写在声明里的点号不会被当成类选择器；
 * `@media` 里的规则递归进去。注释由调用方先剥掉。
 */
function collectSelectors(code: string): string[] {
  const selectors: string[] = [];
  let cursor = 0;

  while (cursor < code.length) {
    const start = cursor;

    while (cursor < code.length) {
      const char = code[cursor] as string;

      if (char === '"' || char === "'") {
        cursor = skipString(code, cursor);
        continue;
      }

      if (char === "{" || char === ";" || char === "}") {
        break;
      }

      cursor += 1;
    }

    if (cursor >= code.length) {
      break;
    }

    const prelude = code.slice(start, cursor).trim();
    const char = code[cursor] as string;

    if (char === ";" || char === "}") {
      // `@import …;` 与块收尾后的残留都不是选择器。
      cursor += 1;
      continue;
    }

    const end = skipBlock(code, cursor);

    if (prelude.startsWith("@")) {
      if (NESTED_AT_RULE.test(prelude)) {
        selectors.push(...collectSelectors(code.slice(cursor + 1, end - 1)));
      }
    } else if (prelude !== "") {
      selectors.push(prelude);
    }

    cursor = end;
  }

  return selectors;
}

/** 选择器里的类名：`.foo` 取 `foo`，`.foo-bar` 取 `foo-bar`。 */
const CLASS_IN_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/gu;

/**
 * 取出样式表里所有「规则选择器」上下文里的类名（不带点）。
 *
 * 组合选择器与伪类按同一份文本取：`.card .project-card:hover` 同时给出 `card` 与 `project-card`，
 * 只要有一条规则给这个类写了声明就算有。声明块、注释、`@media` 的条件文本都不参与。
 */
export function classSelectorsOfCss(css: string): Set<string> {
  const tokens = new Set<string>();

  for (const selector of collectSelectors(stripCssComments(css))) {
    for (const match of selector.matchAll(CLASS_IN_SELECTOR)) {
      const name = match[1];

      if (name !== undefined) {
        tokens.add(name);
      }
    }
  }

  return tokens;
}

/** 清单里出现过的全部模块：全局在前，页面里的按声明顺序接上，重复的只留第一次。 */
export function allModules(spec: ModuleSpec): string[] {
  const modules = [...spec.global];

  for (const page of Object.values(spec.pages)) {
    for (const expected of page.modules) {
      if (!modules.includes(expected)) {
        modules.push(expected);
      }
    }
  }

  return modules;
}

/** 递归列出目录下的 `.tsx` 文件，跳过测试文件。 */
function walkTsx(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...walkTsx(full));
      continue;
    }

    if (!entry.name.endsWith(SOURCE_SUFFIX)) {
      continue;
    }

    if (/\.test\.tsx?$/.test(entry.name)) {
      continue;
    }

    found.push(full);
  }

  return found;
}

/**
 * 把一个页面的 `sources` 展开成具体文件清单。
 *
 * 目录递归取 `.tsx`；单个文件直接收下（后缀不是 `.tsx` 就报错，免得清单写错却静默通过）。
 * 结果去重并按路径排序，报告与日志才稳定。
 */
export function collectSourceFiles(root: string, sources: string[]): string[] {
  const files = new Set<string>();

  for (const source of sources) {
    const target = resolve(root, source);
    let stat;

    try {
      stat = statSync(target);
    } catch {
      throw new Error(`modules.json 里的来源不存在：${source}`);
    }

    if (stat.isDirectory()) {
      for (const file of walkTsx(target)) {
        files.add(relative(root, file));
      }

      continue;
    }

    if (!target.endsWith(SOURCE_SUFFIX)) {
      throw new Error(`modules.json 里的来源不是 ${SOURCE_SUFFIX}：${source}`);
    }

    files.add(relative(root, target));
  }

  return [...files].sort();
}

/** 把 `.module` 写成输出与比对用的 `module`。 */
function bareName(module: string): string {
  return module.startsWith(".") ? module.slice(1) : module;
}

/**
 * 比对清单与源码：某一页该有的模块，在它自己的 `sources` 里有就记为已具备，没有就记为缺失。
 *
 * 全局模块按所有页面扫描到的 class 合起来判定 —— 它们本来就跨页面复用。
 *
 * 再比一遍样式表：清单里的每个模块都要在 `styles`（`app/globals.css` 的全文）里有类选择器规则。
 * 这一项与页面无关 —— 样式补齐不代表页面用上了，两处缺口分开报。
 */
export function compareModules(
  spec: ModuleSpec,
  sources: Record<string, SourceFile[]>,
  styles: string,
): ModuleReport {
  const pages: PageReport[] = [];
  const allTokens = new Set<string>();

  for (const [name, page] of Object.entries(spec.pages)) {
    const tokens = new Set<string>();

    for (const file of sources[name] ?? []) {
      for (const token of classTokensOfSource(file.content)) {
        tokens.add(token);
        allTokens.add(token);
      }
    }

    const missing: string[] = [];
    const present: string[] = [];

    for (const expected of page.modules) {
      if (tokens.has(bareName(expected))) {
        present.push(expected);
      } else {
        missing.push(expected);
      }
    }

    pages.push({ name, route: page.route, missing, present });
  }

  const globalMissing: string[] = [];
  const globalPresent: string[] = [];

  for (const expected of spec.global) {
    if (allTokens.has(bareName(expected))) {
      globalPresent.push(expected);
    } else {
      globalMissing.push(expected);
    }
  }

  const styleTokens = classSelectorsOfCss(styles);
  const styleMissing: string[] = [];
  const stylePresent: string[] = [];

  for (const expected of allModules(spec)) {
    if (styleTokens.has(bareName(expected))) {
      stylePresent.push(expected);
    } else {
      styleMissing.push(expected);
    }
  }

  return {
    pages,
    globalMissing,
    globalPresent,
    styleMissing,
    stylePresent,
    pagesWithMissing: pages.filter((page) => page.missing.length > 0).length,
    pageMissingTotal: pages.reduce((sum, page) => sum + page.missing.length, 0),
  };
}

/** 缺失模块列表的固定写法：模块名之间三个空格，空清单写「无」。 */
function formatModules(modules: string[]): string {
  return modules.length === 0 ? "无" : modules.join("   ");
}

/** 把报告写成给人看的输出，可整段贴进 CI 摘要。 */
export function formatReport(report: ModuleReport): string {
  const lines: string[] = [];

  for (const page of report.pages) {
    lines.push(`页面：${page.route}`);
    lines.push(`  缺失：${formatModules(page.missing)}`);
    lines.push(`  已具备：${formatModules(page.present)}`);
    lines.push("");
  }

  lines.push(`全局模块缺失：${formatModules(report.globalMissing)}`);
  lines.push(`全局模块已具备：${formatModules(report.globalPresent)}`);
  lines.push(`样式表缺失：${formatModules(report.styleMissing)}`);
  lines.push(`样式表已具备：${formatModules(report.stylePresent)}`);
  lines.push("");

  const missingTotal =
    report.pageMissingTotal + report.globalMissing.length + report.styleMissing.length;

  if (missingTotal === 0) {
    lines.push(`结论：${report.pages.length} 个页面全部齐备，全局模块齐备，样式表齐备`);
  } else {
    lines.push(
      `结论：${report.pages.length} 个页面里 ${report.pagesWithMissing} 个有缺失，` +
        `共缺 ${missingTotal} 个模块` +
        `（页面 ${report.pageMissingTotal} 个 + 全局 ${report.globalMissing.length} 个` +
        ` + 样式表 ${report.styleMissing.length} 个）`,
    );
  }

  return lines.join("\n");
}

/** 退出码：默认模式有缺失返回 1；`--report` 恒为 0。参数或输入出错返回 2。 */
export function exitCodeFor(report: ModuleReport, reportOnly: boolean): number {
  if (reportOnly) {
    return 0;
  }

  return report.pageMissingTotal + report.globalMissing.length + report.styleMissing.length > 0
    ? 1
    : 0;
}

function help(): string {
  return [
    "用法：pnpm check:modules [--report] [--help]",
    "",
    "拿 .agents/spec/design/modules.json 的清单，逐页比对实现里还缺哪些原型模块。",
    "只认 className 上下文里的字符串（含三元、模板、clsx），不做全文匹配。",
    "再比对 app/globals.css：清单里的每个模块都要有类选择器规则，声明块与注释里的同名文字不算。",
    "",
    "  （默认）        有缺失时列出明细并以退出码 1 结束，用来阻断",
    "  --report        输出完全相同的报告，但退出码恒为 0，用来在 CI 里先观察",
    "  --help          打印这段说明",
  ].join("\n");
}

function readSpec(root: string): ModuleSpec {
  const file = resolve(root, SPEC_FILE);
  return JSON.parse(readFileSync(file, "utf8")) as ModuleSpec;
}

/** 读源码、比对、打印报告并返回退出码。测试与命令行共用这一条路径。 */
export function run(root: string, argv: string[]): number {
  const unknown = argv.filter((arg) => arg !== "--report" && arg !== "--help");

  if (argv.includes("--help")) {
    console.log(help());
    return 0;
  }

  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}`);
    console.error(help());
    return 2;
  }

  const reportOnly = argv.includes("--report");
  const spec = readSpec(root);
  const sources: Record<string, SourceFile[]> = {};

  for (const [name, page] of Object.entries(spec.pages)) {
    sources[name] = collectSourceFiles(root, page.sources).map((path) => ({
      path,
      content: readFileSync(resolve(root, path), "utf8"),
    }));
  }

  const report = compareModules(
    spec,
    sources,
    readFileSync(resolve(root, STYLE_FILE), "utf8"),
  );
  console.log(formatReport(report));

  return exitCodeFor(report, reportOnly);
}

const invoked = process.argv[1];

if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(SCAN_ROOT, process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
