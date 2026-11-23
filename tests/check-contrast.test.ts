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

test("对比度与 issue 正文的实测值一致（防止公式被改坏）", () => {
  const ratio = (foreground: string, background: string): number => {
    const foregroundRgb = parseHexColor(foreground);
    const backgroundRgb = parseHexColor(background);

    if (foregroundRgb === null || backgroundRgb === null) {
      throw new Error(`色值写法不认识：${foreground} / ${background}`);
    }

    return Number(contrastRatio(foregroundRgb, backgroundRgb).toFixed(2));
  };

  // 逐条抄 issue 正文「定稿 token」那张表的对比度列。
  assert.equal(ratio("#202b3c", "#ffffff"), 14.26);
  assert.equal(ratio("#5d6875", "#ffffff"), 5.67);
  assert.equal(ratio("#5d6875", "#f5f7fa"), 5.28);
  assert.equal(ratio("#3269e8", "#ffffff"), 4.86);
  assert.equal(ratio("#aab7ca", "#172338"), 7.75);
  assert.equal(ratio("#ffffff", "#2d57a8"), 6.91);
  assert.equal(ratio("#0f6b4a", "#eaf8f1"), 5.96);
  assert.equal(ratio("#b0363d", "#fff0f0"), 5.51);
  assert.equal(ratio("#8a5b12", "#fff5e8"), 5.43);
  assert.equal(ratio("#2a5ac4", "#edf3ff"), 5.62);
  assert.equal(ratio("#4f5866", "#f1f3f6"), 6.47);
  assert.equal(ratio("#868c95", "#ffffff"), 3.39);
  assert.equal(ratio("#868c95", "#f5f7fa"), 3.16);
});

test("断言表：正文与非文本两档阈值都在表里用对了", () => {
  assert.equal(TEXT_MINIMUM, 4.5);
  assert.equal(NON_TEXT_MINIMUM, 3);

  const controlBorders = CONTRAST_PAIRS.filter((pair) =>
    pair.foreground.includes("control-border"),
  );

  assert.equal(controlBorders.length, 2);
  assert.ok(controlBorders.every((pair) => pair.minimum === NON_TEXT_MINIMUM));

  const texts = CONTRAST_PAIRS.filter((pair) => !pair.foreground.includes("control-border"));

  assert.ok(texts.length > 0);
  assert.ok(texts.every((pair) => pair.minimum === TEXT_MINIMUM));
});

test("checkContrast：低于阈值的那一对被报成失败，达标的通过", () => {
  const { results, missing } = checkContrast({
    "--color-text": "#202b3c",
    "--color-surface": "#ffffff",
    // 原型里的 #758195 在 #f5f7fa 上只有 3.67:1，正是这次要拒掉的值。
    "--color-text-muted": "#758195",
    "--color-bg": "#f5f7fa",
    "--color-surface-muted": "#fafbfc",
    "--color-primary-weak": "#edf3ff",
    "--color-neutral-weak": "#f1f3f6",
    "--color-primary": "#3269e8",
    "--color-sidebar-text": "#aab7ca",
    "--color-sidebar": "#172338",
    "--color-text-inverse": "#ffffff",
    "--color-sidebar-selected": "#2d57a8",
    "--color-danger": "#b0363d",
    "--color-success": "#0f6b4a",
    "--color-success-weak": "#eaf8f1",
    "--color-danger-weak": "#fff0f0",
    "--color-warn": "#8a5b12",
    "--color-warn-weak": "#fff5e8",
    "--color-info": "#2a5ac4",
    "--color-neutral": "#4f5866",
    "--color-control-border": "#868c95",
  });

  assert.deepEqual(missing, []);

  const failing = results.filter((result) => result.ratio < result.minimum);

  assert.deepEqual(
    failing.map((result) => result.label),
    ["次要文字 / 卡片面", "次要文字 / 画布", "次要文字 / 弱面"],
  );
  assert.ok(failing.every((result) => result.ratio < TEXT_MINIMUM));
});

test("checkContrast：变量缺失单独报出来，不混进对比度失败", () => {
  const { results, missing } = checkContrast({ "--color-text": "#202b3c" });

  assert.equal(results.length, 0);
  assert.ok(missing.length > 0);
  assert.ok(missing.every((item) => item.includes("不在 :root 里")));
});

test("色板：表外颜色被报出来，表内颜色不报", () => {
  const css = `
    :root { --a: #3269e8; --b: #FFFFFF; --c: #fff; }
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

test("认不出的写法：design.md 给定的两条阴影整值不算", () => {
  const css = `
    :root {
      --shadow-card: 0 2px 7px rgba(35, 50, 75, 0.025);
      --shadow-raised: 0 6px 20px rgba(31, 35, 41, 0.08);
    }
  `;

  assert.deepEqual(findUnparseableColors(css), []);
});

test("真实样式表：没有认不出的颜色写法", () => {
  const css = readFileSync(join(process.cwd(), GLOBALS_CSS), "utf8");

  assert.deepEqual(findUnparseableColors(css), []);
});
