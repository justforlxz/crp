/**
 * 侧栏底部的账号区（MKACG-957）。
 *
 * 工作台原先拿「账号名 + 角色」当页头标题，右边还挂着一个「退出登录」——那是只有工作台一个
 * 页面时的遗留。页头恢复成页面名之后，账号名、角色、邮箱与退出登录要落到每个受保护页面都能
 * 看到的侧栏底部，不能靠删掉退出登录来收场。这里锁住侧栏这一层：
 *
 * - 账号名、角色、邮箱与退出登录都在同一个账号区里，账号区在导航之后；
 * - 没有账号（未登录、准备跳登录页）时侧栏照常出导航，但不出账号区；
 * - 账号区带自己的样式锚点，样式门禁量得到它。
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

test("侧栏底部账号区显示账号名、角色、邮箱与退出登录", () => {
  const html = htmlOf(createElement(AppNav, { account: ACCOUNT }));

  assert.match(html, /data-style-anchor="sidebar\.account"/);
  assert.ok(html.includes(ACCOUNT.displayName), "缺账号名");
  assert.ok(html.includes(ACCOUNT.roleLabel), "缺角色");
  assert.ok(html.includes(ACCOUNT.email), "缺邮箱");
  assert.ok(html.includes("退出登录"), "缺退出登录");

  // 账号区在侧栏里、导航之后：侧栏由 layout 挂一次，八个受保护页面共用这一份。
  const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
  assert.ok(aside !== "", "侧栏没渲染出来");
  assert.ok(
    aside.indexOf("app-nav__list") < aside.indexOf("sidebar.account"),
    "账号区应该排在导航之后",
  );
});

test("没有账号时侧栏照常出导航，但不出账号区", () => {
  const html = htmlOf(createElement(AppNav, { account: null }));

  assert.ok(html.includes("app-nav__list"), "侧栏导航应该照常渲染");
  assert.ok(!html.includes("sidebar.account"), "未登录时不该出账号区");
  assert.ok(!html.includes("退出登录"), "未登录时不该出退出登录");
});
