/**
 * 「这个账号能不能看这条提测」的单元测试。
 *
 * 更新页按 id 直接查库，这一处判断是跨工作区读取的唯一关口，必须逐种情况固定住：
 * 提测不存在、账号不属于任何工作区、提测在别的工作区、以及正常可见。
 *
 * 项目详情页（`lib/projects/access.ts`）用的是同一套口径，这里不另立规则。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canViewRelease } from "../lib/releases/access";

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

test("提测在这个账号当前的工作区里：可见", () => {
  assert.equal(
    canViewRelease({
      release: { workspaceId: WORKSPACE_A },
      activeWorkspaceId: WORKSPACE_A,
    }),
    true,
  );
});

test("提测在别的工作区：不可见", () => {
  assert.equal(
    canViewRelease({
      release: { workspaceId: WORKSPACE_B },
      activeWorkspaceId: WORKSPACE_A,
    }),
    false,
  );
});

test("账号不属于任何工作区：不可见（不能用短路把它放过去）", () => {
  assert.equal(
    canViewRelease({ release: { workspaceId: WORKSPACE_A }, activeWorkspaceId: null }),
    false,
  );
});

test("提测不存在：不可见", () => {
  assert.equal(canViewRelease({ release: null, activeWorkspaceId: WORKSPACE_A }), false);
  assert.equal(canViewRelease({ release: null, activeWorkspaceId: null }), false);
});
