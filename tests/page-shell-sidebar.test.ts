/**
 * 侧栏与账号区（界面规范 v2 第二节）。
 *
 * 锁住这一层：
 *
 * - 侧栏是 `.sidebar`，里面有品牌、两组导航（`.nav-group` + `.nav-label` + `.nav-item`）；
 * - 状态徽标 `.nav-count` 只在拿到真实数字时出现，拿不到就不显示，不填猜的数字；
 * - 账号名、角色与退出登录都在底部账号区里，账号区在导航之后；
 * - 没有账号（未登录、准备跳登录页）时侧栏照常出导航，但不出账号区。
 *
 * 「点下去真的回到登录页」要真浏览器，由验收在页面上点，不在这里伪造。
 */

import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AppNav } from "../components/page-shell";

/** 退出登录按钮要用 `useRouter`；服务端渲染时给它一个不动的路由器就能渲染出来。 */
const ROUTER: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

const ACCOUNT = {
  displayName: "预览账号",
  roleLabel: "平台管理员",
  email: "admin@uniontech.com",
};

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: ROUTER }, node),
  );
}

test("侧栏按原型分成品牌、两组导航与底部账号区", () => {
  const html = htmlOf(createElement(AppNav, { account: ACCOUNT, counts: null }));

  assert.match(html, /^<aside class="sidebar">/);
  assert.match(html, /<div class="brand"><div class="brand-mark"/);
  assert.match(html, /<div class="brand-name">提测平台<\/div><div class="brand-sub">Release Hub<\/div>/);

  // 两组导航：工作区与配置，顺序照原型。
  const groups = [...html.matchAll(/<div class="nav-group"><div class="nav-label">([^<]+)<\/div>/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(groups, ["工作区", "配置"]);

  // 每一项都是指向该页的链接，图标 + 文字；当前项高亮要真网址，交给浏览器验收。
  assert.match(html, /<a class="nav-item"[^>]*href="\/dashboard"[^>]*><svg[\s\S]*?<\/svg><span>工作台<\/span><\/a>/u);
});

test("账号区显示头像、账号名、角色与退出登录，且排在导航之后", () => {
  const html = htmlOf(createElement(AppNav, { account: ACCOUNT, counts: null }));

  assert.match(html, /data-style-anchor="sidebar\.account"/);
  assert.match(html, /<span class="avatar" aria-hidden="true">预<\/span>/);
  assert.ok(html.includes(ACCOUNT.displayName), "缺账号名");
  assert.ok(html.includes(ACCOUNT.roleLabel), "缺角色");
  assert.ok(html.includes("退出登录"), "缺退出登录");

  const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
  assert.ok(aside !== "", "侧栏没渲染出来");
  assert.ok(
    aside.indexOf("</nav>") < aside.indexOf("sidebar.account"),
    "账号区应该排在导航之后",
  );
});

/**
 * 账号块本身是凭据页的入口（MKACG-1012）。
 *
 * 凭据按人存放，配置与验证都在 `/settings/credentials` 那一页（MKACG-986）。原型把这块画成
 * 弹窗，只是因为原型只有一个 HTML 文件；实现里已经有那一页，所以这里只要一个链接 ——
 * 挂了链接就不会再出现「点了没反应」。
 */
test("账号块是去凭据页的链接，不再是一块点不动的文字", () => {
  const html = htmlOf(createElement(AppNav, { account: ACCOUNT, counts: null }));

  assert.match(html, /<a class="account"[^>]*href="\/settings\/credentials"/u);
  // 账号块之后紧接着退出登录按钮：两者都在侧栏底部，账号块是链接不是按钮。
  assert.match(html, /<\/a><button type="button" class="nav-item"/u);
});

test("拿不到真实数字时不出徽标", () => {
  const html = htmlOf(createElement(AppNav, { account: ACCOUNT, counts: null }));

  assert.equal(html.includes("nav-count"), false);
});

test("拿到数字时徽标挂在对应项上，数字来自 props", () => {
  const html = htmlOf(
    createElement(AppNav, { account: ACCOUNT, counts: { releases: 12, queue: 3 } }),
  );

  assert.match(html, /<span>提测记录<\/span><span class="nav-count num">12<\/span>/);
  assert.match(html, /<span>构建队列<\/span><span class="nav-count num">3<\/span>/);
  // 没有徽标口径的项不加徽标。
  assert.equal(html.includes("<span>工作台</span><span class=\"nav-count"), false);
});

test("没有账号时侧栏照常出导航，但不出账号区", () => {
  const html = htmlOf(createElement(AppNav, { account: null, counts: null }));

  assert.ok(html.includes("nav-item"), "侧栏导航应该照常渲染");
  assert.ok(!html.includes("sidebar.account"), "未登录时不该出账号区");
  assert.ok(!html.includes("退出登录"), "未登录时不该出退出登录");
});
