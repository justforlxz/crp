/**
 * 工作区内的项目清单。
 *
 * 这一版只提供读取，给权限验收用：跨工作区读取必须是 404，与工作区不存在同一个响应。
 * 项目的增删改由 A10 节点实现，届时复用同一个守卫。
 */
import { NextResponse } from "next/server";

import { publicProject, publicWorkspace } from "@/lib/auth/dto";
import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findWorkspace, listWorkspaceProjects } from "@/lib/auth/store";

export async function GET(
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

  const projects = await listWorkspaceProjects(workspaceId);

  return NextResponse.json({
    workspace: publicWorkspace(workspace, guard.auth.role),
    projects: projects.map(publicProject),
  });
}
