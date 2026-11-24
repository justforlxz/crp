/**
 * 颜色对比度门禁（MKACG-964）。
 *
 * 为什么要有它：界面规范 v2 的配色是原型那套视觉语言，`design.md` 第五节把每个 token 的
 * 用途与实测对比度都写了下来。这些值一旦被谁「顺手调亮一点」，界面看上去没坏，无障碍却已经
 * 坏了，而评审看不出来。所以把那张表里的每一对「文字 on 底色」写成断言，接进 CI：
 * 任何一对低于阈值即失败。
 *
 * 断言读的是 `app/globals.css` 的 `:root` 变量，不是脚本里另抄一份色值 —— 抄一份的话，改 CSS
 * 不会失败，这道门禁就白设了。
 *
 * 两档阈值（WCAG 2.1）：
 *
 * - 正文 4.5:1（1.4.3 AA）。12–14px 的常规字都按这一档；
 * - 非文本 3:1（1.4.11）。控件边框这类「能点的东西的边」按这一档。
 *
 * 另外扫一遍全表的十六进制色值：出现表外的颜色即失败。装饰线（`--color-line`）与控件边框
 * （`--color-control-border`）是两个不同的东西，混用会在这里露出来。
 *
 * 阴影、遮罩与侧栏半透明底用的是整条 `rgba(...)` 值，不是十六进制色值：它们在
 * `TRANSLUCENT_COLOR_VALUES` 里登记，不参与色板扫描。
 *
 * 用法（在仓库根执行）：
 *
 *   pnpm test:contrast
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readCssVariables } from "./style-check/lint";

/** 样式表路径，相对仓库根。 */
export const GLOBALS_CSS = "app/globals.css";

/** 正文阈值（WCAG 2.1 的 1.4.3 AA）。 */
export const TEXT_MINIMUM = 4.5;

/** 非文本阈值（WCAG 2.1 的 1.4.11）。 */
export const NON_TEXT_MINIMUM = 3;

export type Rgb = { r: number; g: number; b: number };

/**
 * 一条「文字 on 底色」断言。
 *
 * `foreground` / `background` 写 `:root` 里的变量名，由脚本去样式表里取值。
 */
export type ContrastPair = {
  /** 报告里给人看的一行说明。 */
  label: string;
  /** 文字色的变量名。 */
  foreground: string;
  /** 底色的变量名。 */
  background: string;
  /** 这一对要达到的下限。 */
  minimum: number;
};

/**
 * `design.md` 第五节「颜色」那张表的逐条翻译。
 *
 * 表里的「实测对比度」一列就是这个文件的期望值：顺序与表一致，先墨色层级，再强调与状态，
 * 最后侧栏与控件边框。表里还有一行「侧栏组标题 `#8593a8`」，原型把它的色值直接写在
 * `.nav-label` 上、没有做成变量，读不到 `:root` 就没有可断言的一对，所以它只在色板里，
 * 不在下面这张断言表里。
 *
 * 改配色要同时改这里与 `app/globals.css`，并回头改 `design.md` 第五节的实测值。
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { label: "正文 / 卡片面", foreground: "--ink", background: "--card", minimum: TEXT_MINIMUM },
  { label: "次级文字 / 卡片面", foreground: "--ink-2", background: "--card", minimum: TEXT_MINIMUM },
  { label: "标签说明 / 卡片面", foreground: "--ink-3", background: "--card", minimum: TEXT_MINIMUM },
  { label: "三级信息 / 卡片面", foreground: "--ink-4", background: "--card", minimum: TEXT_MINIMUM },
  { label: "强调文字 / 卡片面", foreground: "--accent-ink", background: "--card", minimum: TEXT_MINIMUM },
  { label: "主按钮文字 / 主色底", foreground: "--card", background: "--accent", minimum: TEXT_MINIMUM },
  {
    label: "强调文字 / 强调浅底",
    foreground: "--accent-ink",
    background: "--accent-bg",
    minimum: TEXT_MINIMUM,
  },
  { label: "成功状态 / 成功浅底", foreground: "--ok", background: "--ok-bg", minimum: TEXT_MINIMUM },
  { label: "有更新 / 风险浅底", foreground: "--warn", background: "--warn-bg", minimum: TEXT_MINIMUM },
  { label: "失败状态 / 失败浅底", foreground: "--bad", background: "--bad-bg", minimum: TEXT_MINIMUM },
  { label: "等待状态 / 等待浅底", foreground: "--wait", background: "--wait-bg", minimum: TEXT_MINIMUM },
  { label: "三级信息 / 画布", foreground: "--ink-4", background: "--canvas", minimum: TEXT_MINIMUM },
  { label: "侧栏项文字 / 侧栏底", foreground: "--nav-ink", background: "--nav", minimum: TEXT_MINIMUM },
  { label: "侧栏选中文字 / 选中底", foreground: "--card", background: "--nav-3", minimum: TEXT_MINIMUM },
  { label: "控件边框 / 卡片面", foreground: "--line-ctl", background: "--card", minimum: NON_TEXT_MINIMUM },
  { label: "控件边框 / 画布", foreground: "--line-ctl", background: "--canvas", minimum: NON_TEXT_MINIMUM },
];

/**
 * 允许出现在 `app/globals.css` 里的颜色：原型 `<style>` 块里出现的全部十六进制色值去重。
 *
 * 与 `CONTRAST_PAIRS` 分开写：配对说明「哪些颜色放在一起要够清楚」，色板说明「只准用这些
 * 颜色」。原型里有一批只作悬停、描边、浅底用的色值（例如主按钮悬停的 `#2a60d8`），它们不参与
 * 任何一对断言，只有色板这一层能挡住「顺手加一个新颜色」。
 *
 * 新增颜色要同时改这里与 `design.md` 第五节，否则 `pnpm test:contrast` 会报出来。
 */
export const PALETTE: readonly string[] = [
  "#0f7a52",
  "#101828",
  "#101a2c",
  "#18233a",
  "#1e2b45",
  "#1e4fc4",
  "#2a60d8",
  "#2b3a55",
  "#2f6bef",
  "#344054",
  "#4a2f00",
  "#4f8bff",
  "#5b6472",
  "#5c3a00",
  "#667085",
  "#8593a8",
  "#868c95",
  "#8f5400",
  "#98a6bb",
  "#b42318",
  "#c3c9d2",
  "#cfd7e3",
  "#cfd9e8",
  "#d5dce7",
  "#dbe6fb",
  "#e3e8ef",
  "#e6b3ae",
  "#e9f6f0",
  "#eaf0fe",
  "#eef2f6",
  "#f0f2f5",
  "#f2d9b3",
  "#f4f8ff",
  "#f6f7f9",
  "#f8f9fb",
  "#fafbfc",
  "#fafbfd",
  "#fafbff",
  "#fcfcfd",
  "#fdecea",
  "#fdf3e4",
  "#ffffff",
];

/**
 * 把 `#rgb` / `#rrggbb` 解析成三个通道。
 *
 * 只认这两种写法：`rgb()` / `hsl()` 之类写法的对比度要另算，与其猜，不如让它解析失败、
 * 由调用方报「写法不认识」。
 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/u, "");

  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(hex)) {
    return null;
  }

  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : hex;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** 把通道归一化成 `#rrggbb` 小写，用于色板比对。 */
export function normalizeHexColor(color: Rgb): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 2.1 相对亮度：先按 sRGB 反伽马，再按人眼敏感度加权。 */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const ratio = value / 255;

    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 两色的对比度，1:1 到 21:1。与顺序无关。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** 一条断言的结果：通过与否都带上实测值，报告里不用再算一遍。 */
export type ContrastResult = ContrastPair & {
  /** 实测对比度。 */
  ratio: number;
  foregroundValue: string;
  backgroundValue: string;
};

/**
 * 逐对算对比度。
 *
 * 变量缺失单独报出来：那不是「颜色不对」，是有人改了变量名而没改断言表，两种失败要分开看。
 */
export function checkContrast(variables: Record<string, string>): {
  results: ContrastResult[];
  missing: string[];
} {
  const results: ContrastResult[] = [];
  const missing: string[] = [];

  for (const pair of CONTRAST_PAIRS) {
    const foregroundValue = variables[pair.foreground];
    const backgroundValue = variables[pair.background];

    if (foregroundValue === undefined || backgroundValue === undefined) {
      missing.push(
        `${pair.label}：${foregroundValue === undefined ? pair.foreground : pair.background} 不在 :root 里`,
      );
      continue;
    }

    const foreground = parseHexColor(foregroundValue);
    const background = parseHexColor(backgroundValue);

    if (foreground === null || background === null) {
      missing.push(
        `${pair.label}：${foreground === null ? foregroundValue : backgroundValue} 不是 #rgb / #rrggbb`,
      );
      continue;
    }

    results.push({
      ...pair,
      ratio: contrastRatio(foreground, background),
      foregroundValue,
      backgroundValue,
    });
  }

  return { results, missing };
}

/**
 * 扫出样式表里所有十六进制色值，返回不在色板里的那些（去重、按出现顺序）。
 *
 * 解析不了的写法（4/5/7/8 位）不在这里报，交给 `findUnparseableColors()`：那是「写法不认识」，
 * 不是「颜色不对」，两种失败要分开看。
 */
export function findUnlistedColors(css: string, palette: readonly string[]): string[] {
  const allowed = new Set(
    palette
      .map((color) => parseHexColor(color))
      .filter((color): color is Rgb => color !== null)
      .map((color) => normalizeHexColor(color)),
  );

  const unlisted: string[] = [];

  for (const match of css.matchAll(/#[0-9a-f]{3,8}\b/giu)) {
    const parsed = parseHexColor(match[0]);

    if (parsed === null) {
      continue;
    }

    const normalized = normalizeHexColor(parsed);

    if (!allowed.has(normalized) && !unlisted.includes(normalized)) {
      unlisted.push(normalized);
    }
  }

  return unlisted;
}

/**
 * 带透明度的整条颜色值：卡片阴影、弹窗遮罩、侧栏里的半透明白底。
 *
 * 这些不是色板里的「一个颜色」，是「一层叠加」这个整体的一条值：阴影的 rgba 要跟底色一起看
 * 才有意义，拆成十六进制就去掉alpha了。它们同样不参与色板扫描，但要在这里登记，
 * 否则 `findUnparseableColors()` 会把它们当成「认不出的写法」报出来。
 */
export const TRANSLUCENT_COLOR_VALUES: readonly string[] = [
  "rgba(16,24,40,.04)",
  "rgba(16,24,40,.08)",
  "rgba(16,24,40,.18)",
  "rgba(16,24,40,.45)",
  "rgba(255,255,255,.04)",
  "rgba(255,255,255,.07)",
  "rgba(255,255,255,.08)",
  "rgba(255,255,255,.88)",
];

/**
 * 扫出「写法不认识」的颜色：`rgb()` / `hsl()` 这类函数写法，以及 4/5/7/8 位十六进制。
 *
 * 为什么必须报：色板门禁只认 `#rgb` / `#rrggbb`。若静默跳过，写一句
 * `color: rgb(200, 0, 0)` 就能绕过「只准用表里的颜色」这条约定，而门禁照样绿。
 */
export function findUnparseableColors(css: string): string[] {
  const allowed = new Set(TRANSLUCENT_COLOR_VALUES.map((value) => value.replace(/\s+/gu, "")));
  const found: { index: number; text: string }[] = [];

  const report = (index: number, value: string): void => {
    const normalized = value.replace(/\s+/gu, "");

    if (allowed.has(normalized) || found.some((item) => item.text === value)) {
      return;
    }

    found.push({ index, text: value });
  };

  for (const match of css.matchAll(/#[0-9a-f]{3,8}\b/giu)) {
    if (parseHexColor(match[0]) === null) {
      report(match.index, match[0]);
    }
  }

  for (const match of css.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/giu)) {
    report(match.index, match[0]);
  }

  // 按在样式表里出现的顺序报，日志和文件对得上。
  return found.sort((left, right) => left.index - right.index).map((item) => item.text);
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

function main(): number {
  const root = process.cwd();
  const css = readFileSync(join(root, GLOBALS_CSS), "utf8");
  const variables = readCssVariables(css);

  console.log("颜色对比度检查（MKACG-964）");
  console.log(`样式表：${GLOBALS_CSS}`);

  let failures = 0;

  section("文字 on 底色");
  const { results, missing } = checkContrast(variables);

  for (const result of results) {
    const ok = result.ratio >= result.minimum;

    console.log(
      `  ${ok ? "通过" : "不通过"}：${result.label}　${result.foregroundValue} on ${result.backgroundValue}　` +
        `${formatRatio(result.ratio)} ≥ ${formatRatio(result.minimum)}`,
    );

    if (!ok) {
      failures += 1;
    }
  }

  for (const item of missing) {
    console.log(`  不通过：${item}`);
    failures += 1;
  }

  section("色板");
  const unlisted = findUnlistedColors(css, PALETTE);
  const usedCount = new Set(
    [...css.matchAll(/#[0-9a-f]{3,8}\b/giu)]
      .map((match) => parseHexColor(match[0]))
      .filter((color): color is Rgb => color !== null)
      .map((color) => normalizeHexColor(color)),
  ).size;

  if (unlisted.length === 0) {
    console.log(`  通过：${GLOBALS_CSS} 里的 ${String(usedCount)} 个颜色全部在表内`);
  } else {
    console.log(
      `  不通过：${String(unlisted.length)} 个颜色不在表内（新增颜色要同时改 design.md 第五节与 scripts/check-contrast.ts）：${unlisted.join("、")}`,
    );
    failures += unlisted.length;
  }

  const unparseable = findUnparseableColors(css);

  if (unparseable.length === 0) {
    console.log("  通过：没有 rgb() / hsl() 这类色板门禁认不出的写法");
  } else {
    console.log(
      `  不通过：${String(unparseable.length)} 处颜色写法认不出（只认 #rgb / #rrggbb，阴影与遮罩整值除外）：${unparseable.join("、")}`,
    );
    failures += unparseable.length;
  }

  section("结论");
  console.log(`  失败 ${String(failures)} 项`);

  return failures === 0 ? 0 : 1;
}

// 只在直接执行时跑检查：被单测 import 时不能有副作用。
const entry = process.argv[1];

if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
