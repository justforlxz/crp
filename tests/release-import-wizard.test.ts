/**
 * 导入向导第一步的渲染测试（MKACG-946）。
 *
 * 这一步现在有两条路：按名称搜，和「只看我的主题」。两条必须并存 —— 加了新视图就把
 * 关键字搜索删掉是本单明令禁止的。这里把初始状态的渲染结果钉住：
 *
 * - 「只看我的主题」开关在，说明不输关键字也能列；
 * - 关键字输入框与「搜索」按钮默认就在，说明关键字搜索没被新视图替掉；
 * - 基线选择在：两种用法都要先选一条交付分支。
 *
 * 只渲染第一步（默认状态），不连数据库，也不发请求。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ImportWizard } from "../app/(app)/releases/import/wizard";

const html = renderToStaticMarkup(
  createElement(ImportWizard, {
    projects: [],
    baselines: [{ id: "baseline-1", crpBranchId: "108", name: "eagle-1071" }],
    workspaceQuery: "?workspace=desktop-core",
  }),
);

test("第一步同时有「只看我的主题」开关与按关键字搜索", () => {
  assert.match(html, /只看我的主题/, "新视图的开关要在");
  assert.match(html, /主题名关键字/, "关键字搜索的输入框也要在");
  assert.match(html, /id="topic-name"/);
  assert.match(html, /id="topic-baseline"/, "两种用法都要先选基线");
  assert.match(html, /type="checkbox"/);
});

test("默认状态下按关键字搜索可用，「列出我的主题」按钮只在开关打开后出现", () => {
  assert.match(html, />搜索</, "默认是关键字搜索");
  assert.doesNotMatch(html, /列出我的主题/, "没打开开关就不该出现「只看我的主题」的按钮");
});

test("「只看我的主题」不输关键字即可查询，关键字为空时默认按钮是禁用的", () => {
  // 初始状态：关键字为空，所以「搜索」按钮禁用 —— 打开开关才会换成不需要关键字的按钮。
  assert.match(html, /<button[^>]*disabled[^>]*>搜索<\/button>/);
});
