/**
 * 端点页与项目经理页的「新建」入口改成弹窗（MKACG-1002）。
 *
 * 缺陷是这两页把新建表单直接摊在 `.panel` 里，控件没套任何设计类，看起来像没排版；基线页还比
 * 原型多了一个平级面板。这里锁住能在「渲染结果 + 源码」这一层验证的部分：
 *
 * - 两个新建表单里的每个 `<input>` 要么是 `type="hidden"`，要么带 `.input` 设计类（D-1）；
 * - 订阅事件用 `.pick` + `aria-pressed`，不再有裸 checkbox；
 * - 两个页面源码里不再有内嵌的新建表单（D-2 的结构面）；
 * - 基线页只剩一个 `.panel` 与一个 `.tip`（D-4）。
 *
 * 「点开弹窗、× / 遮罩 / Esc 三种关闭」要真浏览器，由 `pnpm test:acceptance:ui` 在页面上点，
 * 不在这里伪造。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { EndpointForm } from "../app/(app)/webhooks/newEndpointDialog";
import { ManagerForm } from "../app/(app)/managers/newManagerDialog";

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function sourceOf(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/**
 * 取出一段 HTML / JSX 里所有 `<input …>` 标签。
 *
 * 这些文件里的属性值不含 `>`，所以「读到第一个 `>`」就是标签结尾；换成完整解析器不划算。
 */
function inputTags(source: string): string[] {
  return [...source.matchAll(/<input\b[^>]*>/gu)].map((match) => match[0]);
}

/** 取控件标签上的 class 值：渲染结果里是 `class`，JSX 源码里是 `className`。 */
function classAttrOf(tag: string): string {
  return /class(?:Name)?="([^"]*)"/u.exec(tag)?.[1] ?? "";
}

/** 数一段 HTML / JSX 里某个 class 出现了几次：只数 class 属性里与它逐字相同的 token。 */
function countClass(html: string, name: string): number {
  let total = 0;

  for (const match of html.matchAll(/class(?:Name)?="([^"]*)"/gu)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token === name) {
        total += 1;
      }
    }
  }

  return total;
}

/** 能套在 `<input>` 上的设计类（design.md 第七节的表单模块）。 */
const INPUT_CLASSES = new Set(["input", "input-sm", "select", "textarea"]);

/** 一个控件要么是隐藏域，要么套了设计类；两者都不是就是「裸控件」。 */
function bareInputs(tags: readonly string[]): string[] {
  return tags.filter((tag) => {
    if (tag.includes('type="hidden"')) {
      return false;
    }

    return !classAttrOf(tag)
      .split(/\s+/)
      .some((token) => INPUT_CLASSES.has(token));
  });
}

const WEBHOOK_FORM = htmlOf(
  createElement(EndpointForm, { workspaceId: "workspace-1", workspaceSlug: "uos" }),
);
const MANAGER_FORM = htmlOf(
  createElement(ManagerForm, { workspaceId: "workspace-1", workspaceSlug: "uos" }),
);

test("新增端点表单没有裸控件：文本框都套 .input", () => {
  assert.deepEqual(bareInputs(inputTags(WEBHOOK_FORM)), []);
  assert.equal(inputTags(WEBHOOK_FORM).filter((tag) => tag.includes('class="input"')).length, 3);
});

test("新建项目经理表单没有裸控件：姓名输入套 .input", () => {
  assert.deepEqual(bareInputs(inputTags(MANAGER_FORM)), []);
  assert.match(MANAGER_FORM, /<input[^>]*class="input"[^>]*name="name"/u);
});

test("订阅事件是 .pick + aria-pressed，不是裸 checkbox", () => {
  assert.equal(WEBHOOK_FORM.includes('type="checkbox"'), false);

  const picks = [...WEBHOOK_FORM.matchAll(/<button\b[^>]*class="pick"[^>]*>/gu)].map(
    (match) => match[0],
  );

  assert.equal(picks.length, 6);
  for (const pick of picks) {
    assert.match(pick, /type="button"/u);
    assert.match(pick, /aria-pressed="false"/u);
  }

  // 选中状态靠 `.check` 里的勾表示，不靠颜色单独表达（design.md 第十节）。
  assert.equal(countClass(WEBHOOK_FORM, "check"), 6);
});

test("两个表单都用 .field + .label 包住控件", () => {
  assert.equal(countClass(WEBHOOK_FORM, "field"), 5);
  assert.equal(countClass(WEBHOOK_FORM, "label"), 5);
  // 项目经理表单只有姓名与邮箱两个输入，没有工作区选择（MKACG-1017）。
  assert.equal(countClass(MANAGER_FORM, "field"), 2);
  assert.equal(countClass(MANAGER_FORM, "label"), 2);
});

test("弹窗挂在 .modal-root 里，压得住表格吸顶表头", () => {
  // `.scrim` 只有 `z-index: auto`，而 `table.grid th` 是 `z-index: 1`：不套固定定位的
  // `.modal-root`，清单表的吸顶表头会横穿弹窗顶部，那一条竖带点不动。
  for (const path of [
    "app/(app)/webhooks/newEndpointDialog.tsx",
    "app/(app)/managers/newManagerDialog.tsx",
  ]) {
    assert.match(sourceOf(path), /<div className="modal-root">\s*<Modal/u, `${path} 缺 .modal-root`);
  }
});

test("页面里不再有内嵌的新建表单", () => {
  for (const [path, action] of [
    ["app/(app)/webhooks/page.tsx", "createEndpointAction"],
    ["app/(app)/managers/page.tsx", "createManagerAction"],
  ] as const) {
    assert.equal(sourceOf(path).includes(action), false, `${path} 仍引用 ${action}`);
  }

  // 页面源码里剩下的 input 只能是隐藏域或行内小输入（改名），不能是新建表单的文本框。
  assert.deepEqual(bareInputs(inputTags(sourceOf("app/(app)/webhooks/page.tsx"))), []);
  assert.deepEqual(bareInputs(inputTags(sourceOf("app/(app)/managers/page.tsx"))), []);
});

test("基线页只剩一个面板与一条提示，与原型一致", () => {
  const source = sourceOf("app/(app)/baselines/page.tsx");

  assert.equal(countClass(source, "panel"), 1);
  assert.equal(countClass(source, "tip"), 1);
  assert.equal(source.includes("同步记录"), false);
});
