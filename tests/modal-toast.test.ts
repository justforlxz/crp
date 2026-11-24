/**
 * 全局 `.modal` 与 `.toast` 的结构测试（MKACG-972）。
 *
 * 锁住的是「页面怎样才算把原型模块搬过来了」这一层：
 *
 * - `.modal` 必须由外层、头部、主体、底部操作区四段组成，头部带标题与关闭按钮；
 * - `.toast` 必须带上页面给的模块名与无障碍角色，没有消息时什么都不渲染；
 * - 模块名（`modal` / `toast`）由页面给出，`pnpm check:modules` 才能在页面源码里读到它。
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

test("弹窗按原型分成外层、头部、主体、底部四段", () => {
  const html = htmlOf(
    modalElement(
      {
        className: "modal",
        title: "确认取消提测",
        onClose: () => undefined,
        footer: createElement("button", { type: "button", className: "btn btn-secondary" }, "取消"),
      },
      createElement("p", null, "不可撤销。"),
    ),
  );

  // 外层：遮罩里包着一层 `.modal`（页面给的模块名原样出现在 className 里）。
  assert.match(html, /<div class="modal-backdrop"><div class="modal card" role="dialog"/);
  assert.match(html, /class="modal-head panel-head"/);
  assert.match(html, /<h3[^>]*>确认取消提测<\/h3>/);
  assert.match(html, /class="modal-body"><p>不可撤销。<\/p><\/div>/);
  assert.match(html, /class="modal-foot"><button type="button" class="btn btn-secondary">取消<\/button><\/div>/);

  // 关闭按钮在头部，带无障碍名字：× 字形本身不读屏。
  assert.match(html, /<button type="button" class="close btn btn-secondary btn-sm" aria-label="关闭"/);
});

test("没有底部操作区时不出空的操作条", () => {
  const html = htmlOf(
    modalElement(
      { className: "modal wide", title: "只读说明", onClose: () => undefined },
      createElement("p", null, "正文"),
    ),
  );

  assert.match(html, /class="modal wide card"/);
  assert.equal(html.includes("modal-foot"), false);
});

test("提示条带上页面给的模块名与无障碍角色", () => {
  const failure = htmlOf(
    createElement(Toast, {
      className: "toast alert alert--error",
      role: "alert",
      message: "操作失败：连接超时",
    }),
  );

  assert.equal(failure, '<div class="toast alert alert--error" role="alert">操作失败：连接超时</div>');

  const notice = htmlOf(
    createElement(Toast, { className: "toast alert alert--info", message: "已保存 3 个软件包" }),
  );

  assert.equal(notice, '<div class="toast alert alert--info" role="status">已保存 3 个软件包</div>');
});

test("没有提示时什么都不渲染", () => {
  const html = htmlOf(
    createElement(Toast, { className: "toast alert alert--info", message: null }),
  );

  assert.equal(html, "");
});

test("提示停留时长是「数秒」量级，够读完一句话又不挡后续操作", () => {
  assert.ok(TOAST_VISIBLE_MS >= 3000 && TOAST_VISIBLE_MS <= 10_000, `实际 ${TOAST_VISIBLE_MS}ms`);
});
