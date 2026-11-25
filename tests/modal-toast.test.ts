/**
 * 全局 `.modal` 与 `.toast` 的结构测试（界面规范 v2 第七节）。
 *
 * 锁住的是「页面怎样才算把原型模块搬过来了」这一层：
 *
 * - `.modal` 必须是遮罩 `.scrim` 里包着的一层，内部固定头部、主体、底部操作区三段，
 *   头部带标题与关闭按钮；
 * - `.toast` 必须带上成功 / 失败档位、图标与无障碍角色，没有消息时什么都不渲染；
 * - 模块名（`modal` / `toast`）由页面或组件给出，`pnpm check:modules` 才读得到它们。
 *
 * 「点遮罩真的关掉」「数秒后真的消失」要真浏览器，由验收在页面上点，不在这里伪造。
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { Modal, type ModalProps } from "../components/modal";
import { Toast, TOAST_VISIBLE_MS } from "../components/toast";

function htmlOf(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

/**
 * 拼一个 `.modal`：`.ts` 测试文件没有 JSX，而 React 19 的 `createElement` 类型要求 children
 * 落在 props 里。这个断言只影响测试的写法，不改变组件的接口。
 */
function modalElement(
  props: Omit<ModalProps, "children">,
  children: ReactNode,
): ReactElement {
  return createElement(Modal, { ...props, children } as ModalProps);
}

test("弹窗是遮罩加头部、主体、底部操作区", () => {
  const html = htmlOf(
    modalElement(
      {
        className: "modal",
        title: "确认取消提测",
        onClose: () => undefined,
        footer: createElement("button", { type: "button", className: "btn" }, "取消"),
      },
      createElement("p", null, "不可撤销。"),
    ),
  );

  // 外层：遮罩里包着一层 `.modal`，无障碍名字指向头部标题。
  assert.match(html, /^<div class="scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="[^"]+">/);
  assert.match(html, /<div class="modal-hd"><h2 id="[^"]+">确认取消提测<\/h2>/);
  assert.match(html, /<div class="modal-bd"><p>不可撤销。<\/p><\/div>/);
  assert.match(html, /<div class="modal-ft"><button type="button" class="btn">取消<\/button><\/div>/);

  // 关闭按钮在头部，带无障碍名字：图形本身不读屏。
  assert.match(html, /<button type="button" class="icon-btn" aria-label="关闭">/);
});

test("头部可以带一句小字，宽版用 is-wide", () => {
  const html = htmlOf(
    modalElement(
      {
        className: "modal is-wide",
        title: "创建提测",
        subtitle: "第 2 步，共 3 步",
        onClose: () => undefined,
      },
      createElement("p", null, "正文"),
    ),
  );

  assert.match(html, /<div class="modal is-wide"/);
  assert.match(html, /<span class="modal-sub">第 2 步，共 3 步<\/span>/);
  assert.match(html, /<\/div><div class="modal-bd"><p>正文<\/p><\/div>/);
});

test("没有底部操作区时不出空的操作条", () => {
  const html = htmlOf(
    modalElement(
      { className: "modal is-wide", title: "只读说明", onClose: () => undefined },
      createElement("p", null, "正文"),
    ),
  );

  assert.match(html, /class="modal is-wide"/);
  assert.equal(html.includes("modal-ft"), false);
});

test("提示条带上页面给的档位类名与无障碍角色", () => {
  const failure = htmlOf(
    createElement(Toast, { className: "toast bad", role: "alert", message: "操作失败：连接超时" }),
  );

  assert.match(failure, /^<div class="toast bad" role="alert">/);
  assert.ok(failure.includes("操作失败：连接超时"));

  const notice = htmlOf(createElement(Toast, { className: "toast ok", message: "已保存 3 个软件包" }));

  assert.match(notice, /^<div class="toast ok" role="status">/);
  assert.ok(notice.includes("已保存 3 个软件包"));
});

test("提示条里有图标：不靠颜色单独表达结果", () => {
  const ok = htmlOf(createElement(Toast, { className: "toast ok", message: "完成" }));

  assert.match(ok, /<svg/);
});

test("没有提示时什么都不渲染", () => {
  const html = htmlOf(createElement(Toast, { className: "toast ok", message: null }));

  assert.equal(html, "");
});

test("提示停留时长是 design.md 的 4.2 秒", () => {
  assert.equal(TOAST_VISIBLE_MS, 4200);
});
