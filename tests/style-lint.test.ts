/**
 * 样式门禁的静态检查（A20）。
 *
 * L1 的四条判据里有三条靠正则扫源码，容易被注释、字符串、属性写法绕过去。这里锁住：
 *
 * - CSS 规则数只数真实的声明块，注释与字符串里的花括号不算；
 * - `:root` 的设计变量按名字取值，注释不影响解析；
 * - 裸 `<table>` 只看开标签自己带没带 `.data-table`，不因为旁边别的元素带了类就放过；
 * - 内联 `style={{` 与 `PageShell` 的判定不误伤 `style=` 之外的写法。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  countCssRuleBlocks,
  findBareTables,
  findInlineStyles,
  readCssVariables,
  usesPageShell,
} from "../scripts/style-check/lint";

test("规则数只数声明块：注释里的花括号与字符串里的花括号都不算", () => {
  const css = `
    /* 这条注释里有 { 和 } */
    :root { --a: 1px; }
    .x { color: red; }
    .y::before { content: "{"; }
  `;

  assert.equal(countCssRuleBlocks(css), 3);
});

test("规则数不会因为删除规则而变多：少一条就少一", () => {
  const before = `:root { --a: 1px; } .x { color: red; } .y { color: blue; }`;
  const after = `:root { --a: 1px; } .x { color: red; }`;

  assert.equal(countCssRuleBlocks(before) - countCssRuleBlocks(after), 1);
});

test("设计变量从 :root 里按名字取值，注释与顺序都不影响", () => {
  const css = `
    /* 设计变量 */
    :root {
      --radius-md: 6px;
      /* 卡片圆角 */
      --radius-lg: 10px;
    }
    .card { border-radius: var(--radius-lg); }
  `;

  assert.deepEqual(readCssVariables(css), {
    "--radius-md": "6px",
    "--radius-lg": "10px",
  });
});

test("带引号的变量值原样保留，不因去注释被截成残缺值", () => {
  const css = `
    :root {
      --font-mono: ui-monospace, "Liberation Mono", monospace;
      --content: "a;b";
    }
  `;

  assert.deepEqual(readCssVariables(css), {
    "--font-mono": 'ui-monospace, "Liberation Mono", monospace',
    "--content": '"a;b"',
  });
});

test("只改引号里的字体名也算变量值变化", () => {
  const before = readCssVariables(':root { --font-mono: ui-monospace, "Liberation Mono", monospace; }');
  const after = readCssVariables(':root { --font-mono: ui-monospace, "DejaVu Sans Mono", monospace; }');

  assert.notDeepEqual(before, after);
});

test("注释里的花括号不算规则数，但引号外的花括号照常算", () => {
  const css = ':root { --a: 1px; } /* .x { color: red; } */ .y { color: blue; }';

  assert.equal(countCssRuleBlocks(css), 2);
});

test("没有 :root 时设计变量是空表，不抛错", () => {
  assert.deepEqual(readCssVariables(".card { color: red; }"), {});
});

test("裸 <table> 指开标签上没带表模块类名的那些", () => {
  const source = `
    <div className="table-scroll">
      <table className="data-table">
        <tbody><tr><td>v1 的表格</td></tr></tbody>
      </table>
      <table className="grid">
        <tbody><tr><td>v2 的表格</td></tr></tbody>
      </table>
    </div>
    <table>
      <tbody><tr><td>裸的</td></tr></tbody>
    </table>
  `;

  const hits = findBareTables(source);

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.line, 10);
});

test("表格模块类名认 .data-table 与 .grid 两种写法", () => {
  assert.equal(findBareTables(`<table className="data-table">`).length, 0);
  assert.equal(findBareTables(`<table className="grid">`).length, 0);
  assert.equal(findBareTables(`<table className="grid wide">`).length, 0);
  assert.equal(findBareTables(`<table>`).length, 1);
});

test("内联 style 只看对象写法，普通 style 属性不算", () => {
  assert.equal(findInlineStyles(`<div style={{ color: "red" }} />`).length, 1);
  assert.equal(findInlineStyles(`<div className="x" />`).length, 0);
});

test("等号两边带空格的内联 style 也要抓到", () => {
  assert.equal(findInlineStyles(`<div style = {{ color: "red" }} />`).length, 1);
  assert.equal(findInlineStyles(`<div style  ={{ color: "red" }} />`).length, 1);
});

test("PageShell 既要引进来也要用上", () => {
  const used = `
    import { PageShell } from "@/components/page-shell";
    export default function Page() { return <PageShell title="x">y</PageShell>; }
  `;
  const importedOnly = `import { PageShell } from "@/components/page-shell";`;

  assert.equal(usesPageShell(used), true);
  assert.equal(usesPageShell(importedOnly), false);
});
