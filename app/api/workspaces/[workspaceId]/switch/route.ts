/**
 * 切换当前工作区：把选中的工作区写进会话。
 *
 * 权限与「读这个工作区」一致：没成员关系返回 404，形状与工作区不存在相同。
 * 平台管理员可以切到任意工作区，但工作区本身必须存在。
 */
import { NextResponse } from "next/server";

import { publicWorkspace } from "@/lib/auth/dto";
import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findWorkspace, setActiveWorkspace } from "@/lib/auth/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const { workspaceId } = await context.params;
  const guard = await requireRole({ scope: "workspace", workspaceId, role: "reader" });

  if (!guard.ok) {
    return guard.response;
  }

  const workspace = await findWorkspace(workspaceId);

  if (workspace === null) {
    return errorJson(404, "workspace_not_found", "工作区不存在");
  }

  await setActiveWorkspace(guard.auth.sessionId, workspaceId);

  return NextResponse.json({ activeWorkspace: publicWorkspace(workspace, guard.auth.role) });
}
