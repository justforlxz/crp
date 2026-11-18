/**
 * 工作区清单：平台管理员看到全部，其余账号只看到自己有成员关系的。
 */
import { NextResponse } from "next/server";

import { publicWorkspace } from "@/lib/auth/dto";
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

  return NextResponse.json({
    workspaces: workspaces.map((workspace) => publicWorkspace(workspace, workspace.role)),
  });
}
