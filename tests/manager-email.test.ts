/**
 * 项目经理的邮箱与「修改在弹窗里」（MKACG-1017）。
 *
 * 锁住这一层能静态验证的部分：
 *
 * - 经理卡第二行是邮箱；没填的写「未填写邮箱」，不写绑定状态，也不写工作区；
 * - 新建 / 编辑项目经理的表单只有姓名与邮箱两个输入，没有工作区选择；
 * - 清单表四列：姓名 / 邮箱 / 名下项目 / 进行中提测，没有「工作区」「平台账号」「改名」；
 * - 传了 `onEdit` 才知道卡片可点（项目经理页打开编辑弹窗），不传时是纯展示的 `div`。
 *
 * 「点卡片真的弹出弹窗」「单工作区时页面上没有下拉」要真浏览器，由验收在页面上点。
 */

// 渲染 `ManagerForm` 会把服务端动作（及其 `lib/db`）一起加载，所以要先把 `.env` 读进来；
// 与 `tests/webhook-manager-dialogs.test.ts` 同一处理。
import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { ManagerCardData } from "../lib/projects";
import { ManagerGrid } from "../app/(app)/managers/managerGrid";
import { ManagerForm } from "../app/(app)/managers/newManagerDialog";

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function sourceOf(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function manager(overrides: Partial<ManagerCardData> & { name: string }): ManagerCardData {
  return {
    id: `manager-${overrides.name}`,
    email: null,
    userId: null,
    projectCount: 0,
    activeReleaseCount: 0,
    ...overrides,
  };
}

/** 表格表头：只取 `<th>…</th>` 里的文字，正文里出现同样的词不算。 */
function tableHeaders(source: string): string[] {
  return [...source.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gu)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/gu, "").trim(),
  );
}

test("新建项目经理只有姓名与邮箱两个输入，没有工作区选择", () => {
  const form = htmlOf(
    createElement(ManagerForm, { workspaceId: "workspace-1", workspaceSlug: "desktop-core" }),
  );

  const visibleInputs = [...form.matchAll(/<input\b[^>]*>/gu)]
    .map((match) => match[0])
    .filter((tag) => !tag.includes('type="hidden"'));

  assert.deepEqual(
    visibleInputs.map((tag) => /name="([^"]*)"/u.exec(tag)?.[1]),
    ["name", "email"],
  );
  // 不是「不能提到工作区」：提示里本来就要说清归属规则。不能有的是**工作区选择控件**：
  // 没有下拉，唯一带 workspace 字样的输入是隐藏域。
  assert.doesNotMatch(form, /<select/);
  assert.doesNotMatch(form, /name="workspace"/u);
  assert.match(form, /name="workspaceId"/u);
  assert.match(form, /姓名在当前工作区内唯一/u);
  assert.match(form, /其他组的人在他们自己的工作区里添加/u);
});

test("编辑项目经理用一个带 managerId 的隐藏域提交，字段还是姓名与邮箱", () => {
  const form = htmlOf(
    createElement(ManagerForm, {
      workspaceId: "workspace-1",
      workspaceSlug: "desktop-core",
      manager: { id: "manager-1", name: "李伟", email: "liwei@uniontech.com" },
    }),
  );

  assert.match(form, /name="managerId" value="manager-1"/u);
  assert.match(form, /name="name"[^>]*value="李伟"/u);
  assert.match(form, /name="email"[^>]*value="liwei@uniontech\.com"/u);
  assert.doesNotMatch(form, /<select/);
});

test("经理卡第二行显示邮箱，没填的说「未填写邮箱」，不写绑定状态", () => {
  const html = htmlOf(
    createElement(ManagerGrid, {
      managers: [
        manager({ name: "李伟", email: "liwei@uniontech.com" }),
        manager({ name: "刘洋" }),
      ],
    }),
  );

  assert.match(html, /liwei@uniontech\.com/u);
  assert.match(html, /未填写邮箱/u);
  assert.doesNotMatch(html, /平台账号/u);
  assert.doesNotMatch(html, /工作区/u);
});

test("传了 onEdit 时卡片是按钮，不传时是纯展示的 div", () => {
  const managers = [manager({ name: "李伟", email: "liwei@uniontech.com" })];

  const clickable = htmlOf(createElement(ManagerGrid, { managers, onEdit: () => undefined }));
  assert.equal((clickable.match(/<button\b/gu) ?? []).length, 1);
  assert.match(clickable, /<button[^>]*class="manager-card"/u);
  assert.match(clickable, /aria-label="编辑项目经理 李伟"/u);

  const plain = htmlOf(createElement(ManagerGrid, { managers }));
  assert.doesNotMatch(plain, /<button/u);
  assert.match(plain, /<div class="manager-card">/u);
});

test("清单表四列：姓名 / 邮箱 / 名下项目 / 进行中提测", () => {
  const source = sourceOf("app/(app)/managers/page.tsx");

  assert.deepEqual(tableHeaders(source), ["姓名", "邮箱", "名下项目", "进行中提测"]);
});
