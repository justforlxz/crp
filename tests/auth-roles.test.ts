import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLE_LABELS,
  WORKSPACE_ROLES,
  accountRole,
  decideAccountAccess,
  decideWorkspaceAccess,
  hasRole,
  isWorkspaceRole,
  type Subject,
  type WorkspaceRoleName,
} from "../lib/auth/roles";

const anonymous: Subject = { kind: "anonymous" };
const platformAdmin: Subject = { kind: "user", isPlatformAdmin: true, workspaceRole: null };
const workspaceMember = (workspaceRole: WorkspaceRoleName | null): Subject => ({
  kind: "user",
  isPlatformAdmin: false,
  workspaceRole,
});

test("角色高低：只读 < 开发者 < 项目经理 < 平台管理员", () => {
  assert.equal(hasRole("platform_admin", "project_manager"), true);
  assert.equal(hasRole("project_manager", "developer"), true);
  assert.equal(hasRole("developer", "reader"), true);
  assert.equal(hasRole("reader", "developer"), false);
  assert.equal(hasRole("developer", "project_manager"), false);
  assert.equal(hasRole("reader", "reader"), true);
});

test("账号级判定：未登录 401，登录了但不是平台管理员要 403（AC2 的半边）", () => {
  assert.deepEqual(decideAccountAccess(anonymous, "reader"), {
    allowed: false,
    status: 401,
    code: "unauthenticated",
    message: "请先登录",
  });

  const member = workspaceMember(null);
  assert.equal(decideAccountAccess(member, "reader").allowed, true);

  const denied = decideAccountAccess(member, "platform_admin");
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false ? denied.status : 0, 403);

  const admin = decideAccountAccess(platformAdmin, "platform_admin");
  assert.deepEqual(admin, { allowed: true, role: "platform_admin" });
});

test("工作区级判定：未登录先 401，没成员关系一律 404 —— 与工作区不存在同一个响应（AC4）", () => {
  const unauthenticated = decideWorkspaceAccess(anonymous, "reader");
  assert.equal(unauthenticated.allowed === false ? unauthenticated.status : 0, 401);

  const stranger = decideWorkspaceAccess(workspaceMember(null), "reader");
  assert.deepEqual(stranger, {
    allowed: false,
    status: 404,
    code: "workspace_not_found",
    message: "工作区不存在",
  });
});

test("工作区级判定：只读成员写接口 403，读接口放行（AC3）", () => {
  const reader = workspaceMember("reader");

  const read = decideWorkspaceAccess(reader, "reader");
  assert.deepEqual(read, { allowed: true, role: "reader" });

  const write = decideWorkspaceAccess(reader, "developer");
  assert.deepEqual(write, {
    allowed: false,
    status: 403,
    code: "forbidden",
    message: "当前角色不能执行这个操作",
  });
});

test("工作区级判定：开发者满足开发者，项目经理也满足开发者，管理员无视成员关系", () => {
  assert.deepEqual(decideWorkspaceAccess(workspaceMember("developer"), "developer"), {
    allowed: true,
    role: "developer",
  });
  assert.deepEqual(decideWorkspaceAccess(workspaceMember("project_manager"), "developer"), {
    allowed: true,
    role: "project_manager",
  });
  assert.deepEqual(decideWorkspaceAccess(platformAdmin, "developer"), {
    allowed: true,
    role: "platform_admin",
  });
});

test("账号生效角色：只有平台管理员这一种账号级角色，其余按只读计", () => {
  assert.equal(accountRole(true), "platform_admin");
  assert.equal(accountRole(false), "reader");
});

test("角色清单与中文名：三种工作区角色各有一个标签，请求体里的非法角色被拒绝", () => {
  assert.deepEqual([...WORKSPACE_ROLES], ["project_manager", "developer", "reader"]);

  for (const role of WORKSPACE_ROLES) {
    assert.equal(typeof ROLE_LABELS[role], "string");
  }
  assert.equal(ROLE_LABELS.platform_admin, "平台管理员");

  assert.equal(isWorkspaceRole("developer"), true);
  assert.equal(isWorkspaceRole("platform_admin"), false);
  assert.equal(isWorkspaceRole("owner"), false);
  assert.equal(isWorkspaceRole(""), false);
});
