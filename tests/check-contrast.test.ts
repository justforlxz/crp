/**
 * 颜色对比度门禁（MKACG-964）。
 *
 * 这道门禁的价值全在「改 CSS 就会失败」上，所以除了纯函数本身，还要锁住两条不变量：
 *
 * - 真实的 `app/globals.css` 里，断言表上的每一对都达标；
 * - 真实的 `app/globals.css` 里没有表外颜色。
 *
 * 只测纯函数的话，把断言表的阈值改成 1 也能全绿 —— 那正是「门禁绿但无障碍坏了」。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CONTRAST_PAIRS,
  GLOBALS_CSS,
  NON_TEXT_MINIMUM,
  PALETTE,
  TEXT_MINIMUM,
  checkContrast,
  contrastRatio,
  findUnparseableColors,
  findUnlistedColors,
  normalizeHexColor,
  parseHexColor,
  relativeLuminance,
} from "../scripts/check-contrast";
import { readCssVariables } from "../scripts/style-check/lint";

test("十六进制色值：六位、三位、大小写都能解析", () => {
  assert.deepEqual(parseHexColor("#202b3c"), { r: 0x20, g: 0x2b, b: 0x3c });
  assert.deepEqual(parseHexColor("202B3C"), { r: 0x20, g: 0x2b, b: 0x3c });
  assert.deepEqual(parseHexColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor(" #abc "), { r: 0xaa, g: 0xbb, b: 0xcc });
});

test("十六进制色值：其它写法解析失败，不猜", () => {
  assert.equal(parseHexColor("rgba(0, 0, 0, 0.5)"), null);
  assert.equal(parseHexColor("#12345"), null);
  assert.equal(parseHexColor("#gggggg"), null);
  assert.equal(parseHexColor(""), null);
});

test("相对亮度：黑 0、白 1", () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test("对比度：黑白 21:1，同色 1:1，与顺序无关", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };

  assert.equal(contrastRatio(black, white), 21);
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(black, black), 1);
});

test("对比度与 design.md 第五节的实测值一致（防止公式被改坏）", () => {
  const ratio = (foreground: string, background: string): number => {
    const foregroundRgb = parseHexColor(foreground);
    const backgroundRgb = parseHexColor(background);

    if (foregroundRgb === null || backgroundRgb === null) {
      throw new Error(`色值写法不认识：${foreground} / ${background}`);
    }

    return Number(contrastRatio(foregroundRgb, backgroundRgb).toFixed(2));
  };

  // 逐条抄 design.md 第五节「颜色」那张表的「实测对比度」一列。
  assert.equal(ratio("#101828", "#ffffff"), 17.75);
  assert.equal(ratio("#344054", "#ffffff"), 10.46);
  assert.equal(ratio("#5b6472", "#ffffff"), 5.98);
  assert.equal(ratio("#667085", "#ffffff"), 4.97);
  assert.equal(ratio("#1e4fc4", "#ffffff"), 7.07);
  assert.equal(ratio("#ffffff", "#2f6bef"), 4.7);
  assert.equal(ratio("#1e4fc4", "#eaf0fe"), 6.19);
  assert.equal(ratio("#0f7a52", "#e9f6f0"), 4.82);
  assert.equal(ratio("#8f5400", "#fdf3e4"), 5.56);
  assert.equal(ratio("#b42318", "#fdecea"), 5.75);
  assert.equal(ratio("#5b6472", "#f0f2f5"), 5.33);
  assert.equal(ratio("#868c95", "#ffffff"), 3.39);
  assert.equal(ratio("#98a6bb", "#101a2c"), 7.05);
  // 表里这两行写的是十六进制而不是变量：侧栏组标题没有做成变量，选中底另算。色板里都有它们。
  assert.equal(ratio("#8593a8", "#101a2c"), 5.58);
  assert.equal(ratio("#ffffff", "#1e2b45"), 14.13);
});

test("断言表：正文与非文本两档阈值都在表里用对了", () => {
  assert.equal(TEXT_MINIMUM, 4.5);
  assert.equal(NON_TEXT_MINIMUM, 3);

  const controlBorders = CONTRAST_PAIRS.filter((pair) => pair.foreground.includes("line-ctl"));

  assert.equal(controlBorders.length, 2);
  assert.ok(controlBorders.every((pair) => pair.minimum === NON_TEXT_MINIMUM));

  const texts = CONTRAST_PAIRS.filter((pair) => !pair.foreground.includes("line-ctl"));

  assert.ok(texts.length > 0);
  assert.ok(texts.every((pair) => pair.minimum === TEXT_MINIMUM));
});

test("checkContrast：低于阈值的那一对被报成失败，达标的通过", () => {
  const { results, missing } = checkContrast({
    "--ink": "#101828",
    "--ink-2": "#344054",
    "--ink-3": "#5b6472",
    // 比 design.md 的 #667085 亮一档：在白面上只有 3.06:1，正是要拒掉的值。
    "--ink-4": "#8a94a6",
    "--accent-ink": "#1e4fc4",
    "--accent": "#2f6bef",
    "--accent-bg": "#eaf0fe",
    "--ok": "#0f7a52",
    "--ok-bg": "#e9f6f0",
    "--warn": "#8f5400",
    "--warn-bg": "#fdf3e4",
    "--bad": "#b42318",
    "--bad-bg": "#fdecea",
    "--wait": "#5b6472",
    "--wait-bg": "#f0f2f5",
    "--canvas": "#f6f7f9",
    "--card": "#ffffff",
    "--line-ctl": "#868c95",
    "--nav-ink": "#98a6bb",
    "--nav": "#101a2c",
    "--nav-3": "#1e2b45",
  });

  assert.deepEqual(missing, []);

  const failing = results.filter((result) => result.ratio < result.minimum);

  assert.deepEqual(
    failing.map((result) => result.label),
    ["三级信息 / 卡片面", "三级信息 / 画布"],
  );
  assert.ok(failing.every((result) => result.ratio < TEXT_MINIMUM));
});

test("checkContrast：变量缺失单独报出来，不混进对比度失败", () => {
  const { results, missing } = checkContrast({ "--ink": "#101828" });

  assert.equal(results.length, 0);
  assert.ok(missing.length > 0);
  assert.ok(missing.every((item) => item.includes("不在 :root 里")));
});

test("色板：表外颜色被报出来，表内颜色不报", () => {
  const css = `
    :root { --a: #2f6bef; --b: #FFFFFF; --c: #fff; }
    .x { color: #123456; border-color: #123456; }
    .y { background: rgba(35, 50, 75, 0.025); }
  `;

  assert.deepEqual(findUnlistedColors(css, PALETTE), ["#123456"]);
});

test("色板：三位写法按六位归一，不会误报", () => {
  assert.deepEqual(findUnlistedColors(".x { color: #fff; }", ["#ffffff"]), []);
  assert.equal(normalizeHexColor({ r: 255, g: 255, b: 255 }), "#ffffff");
});

test("真实样式表：断言表上的每一对都达标", () => {
  const css = readFileSync(join(process.cwd(), GLOBALS_CSS), "utf8");
  const { results, missing } = checkContrast(readCssVariables(css));

  assert.deepEqual(missing, []);
  assert.equal(results.length, CONTRAST_PAIRS.length);

  for (const result of results) {
    assert.ok(
      result.ratio >= result.minimum,
      `${result.label}：${result.foregroundValue} on ${result.backgroundValue} 实测 ${result.ratio.toFixed(2)}:1，低于 ${String(result.minimum)}:1`,
    );
  }
});

test("真实样式表：没有表外颜色", () => {
  const css = readFileSync(join(process.cwd(), GLOBALS_CSS), "utf8");

  assert.deepEqual(findUnlistedColors(css, PALETTE), []);
});

test("认不出的写法：rgb() / hsl() 与 4/5/7 位十六进制都要报出来", () => {
  const css = `
    .a { color: rgb(200, 0, 0); }
    .b { color: hsl(0 100% 50%); }
    .c { color: #12345; }
    .d { color: #1234567; }
  `;

  assert.deepEqual(findUnparseableColors(css), [
    "rgb(200, 0, 0)",
    "hsl(0 100% 50%)",
    "#12345",
    "#1234567",
  ]);
});

test("认不出的写法：阴影、遮罩与半透明底这些整值不算", () => {
  const css = `
    :root {
      --shadow-card: 0 1px 2px rgba(16,24,40,.04);
      --shadow-pop: 0 12px 32px -8px rgba(16,24,40,.18), 0 4px 8px -4px rgba(16,24,40,.08);
    }
    .scrim { background: rgba(16,24,40,.45); }
    .nav-count { background: rgba(255,255,255,.07); }
  `;

  assert.deepEqual(findUnparseableColors(css), []);
});

test("真实样式表：没有认不出的颜色写法", () => {
  const css = readFileSync(join(process.cwd(), GLOBALS_CSS), "utf8");

  assert.deepEqual(findUnparseableColors(css), []);
});
