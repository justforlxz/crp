/**
 * 当前登录状态：账号、生效角色、当前工作区与可见工作区清单。
 *
 * 未登录返回 401（不是 500），前端拿它判断要不要跳登录页。
 */
import { NextResponse } from "next/server";

import { publicAccount, publicWorkspace } from "@/lib/auth/dto";
import { requireRole } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";

export async function GET(): Promise<NextResponse> {
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    return guard.response;
  }

  const workspaces = await listWorkspacesForAccount(
    guard.auth.account.id,
    guard.auth.account.isPlatformAdmin,
  );
  const active = workspaces.find((workspace) => workspace.id === guard.auth.workspaceId) ?? null;

  return NextResponse.json({
    user: publicAccount(guard.auth.account),
    role: guard.auth.role,
    activeWorkspace: active === null ? null : publicWorkspace(active, active.role),
    workspaces: workspaces.map((workspace) => publicWorkspace(workspace, workspace.role)),
  });
}
