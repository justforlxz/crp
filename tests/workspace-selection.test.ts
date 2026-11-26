/**
 * 「当前在哪个工作区」的选法（MKACG-953）。
 *
 * 锁住三条规则与一条兜底：
 *
 * - 查询串点名的优先；
 * - 没点名（或点了不存在的一个）时，用会话里记住的；
 * - 会话还没记住任何工作区时，落到第一个可访问的 —— 平台管理员刚注册就是这种状态，
 *   不兜底的话工作台停在「先选一个工作区」的空转页上；
 * - 一个工作区都没有时返回 `null`，页面自己说「请管理员分配」。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { pickActiveWorkspace, showsWorkspaceSwitcher } from "../lib/auth/workspaces";

const WORKSPACES = [
  { id: "ws-security", slug: "security", name: "测试工作区" },
  { id: "ws-desktop", slug: "desktop-core", name: "我的工作区" },
  { id: "ws-system", slug: "system-apps", name: "备用工作区" },
] as const;

test("查询串点名的优先于会话记住的", () => {
  assert.equal(
    pickActiveWorkspace(WORKSPACES, {
      requestedSlug: "system-apps",
      sessionWorkspaceId: "ws-desktop",
    })?.id,
    "ws-system",
  );
});

test("没点名时用会话里记住的", () => {
  assert.equal(
    pickActiveWorkspace(WORKSPACES, { sessionWorkspaceId: "ws-desktop" })?.id,
    "ws-desktop",
  );
});

test("会话还没记住工作区时落到第一个可访问的", () => {
  assert.equal(
    pickActiveWorkspace(WORKSPACES, { sessionWorkspaceId: null })?.id,
    "ws-security",
  );
});

test("点了一个不存在的工作区时退回会话记住的", () => {
  assert.equal(
    pickActiveWorkspace(WORKSPACES, {
      requestedSlug: "no-such-workspace",
      sessionWorkspaceId: "ws-desktop",
    })?.id,
    "ws-desktop",
  );
});

test("一个工作区都没有时返回 null", () => {
  assert.equal(pickActiveWorkspace([], { sessionWorkspaceId: null }), null);
  assert.equal(
    pickActiveWorkspace([], { requestedSlug: "security", sessionWorkspaceId: null }),
    null,
  );
});

test("只有一个工作区时不渲染切换器（MKACG-1017）", () => {
  assert.equal(showsWorkspaceSwitcher([]), false);
  assert.equal(showsWorkspaceSwitcher([WORKSPACES[0]]), false);
});

test("两个以上工作区时才渲染切换器，页面上才有得切", () => {
  assert.equal(showsWorkspaceSwitcher([WORKSPACES[0], WORKSPACES[1]]), true);
  assert.equal(showsWorkspaceSwitcher(WORKSPACES), true);
});
