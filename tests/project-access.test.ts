import assert from "node:assert/strict";
import test from "node:test";

import { canViewProject } from "../lib/projects/access";

const PROJECT = { workspaceId: "ws-1", deletedAt: null };
const DELETED = { workspaceId: "ws-1", deletedAt: new Date("2026-11-18T00:00:00Z") };

test("项目不存在时不可看", () => {
  assert.equal(
    canViewProject({ project: null, activeWorkspaceId: "ws-1", isPlatformAdmin: true }),
    false,
  );
});

test("账号不属于任何工作区时，按 id 也看不到项目（跨工作区权限绕过）", () => {
  assert.equal(
    canViewProject({ project: PROJECT, activeWorkspaceId: null, isPlatformAdmin: false }),
    false,
  );
});

test("项目属于另一个工作区时不可看", () => {
  assert.equal(
    canViewProject({ project: PROJECT, activeWorkspaceId: "ws-2", isPlatformAdmin: false }),
    false,
  );
});

test("项目属于当前工作区时可以看", () => {
  assert.equal(
    canViewProject({ project: PROJECT, activeWorkspaceId: "ws-1", isPlatformAdmin: false }),
    true,
  );
});

test("已删除的项目只给平台管理员看", () => {
  assert.equal(
    canViewProject({ project: DELETED, activeWorkspaceId: "ws-1", isPlatformAdmin: false }),
    false,
  );
  assert.equal(
    canViewProject({ project: DELETED, activeWorkspaceId: "ws-1", isPlatformAdmin: true }),
    true,
  );
});

test("平台管理员也要求项目落在当前工作区里", () => {
  assert.equal(
    canViewProject({ project: PROJECT, activeWorkspaceId: "ws-2", isPlatformAdmin: true }),
    false,
  );
});
