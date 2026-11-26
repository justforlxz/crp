/**
 * 受保护页面共用的工作区范围。
 *
 * `app/(app)` 下的页面自己找「当前是谁、在哪个工作区」：先过 `requirePageAuth`（没登录跳登录页），
 * 再取这个账号能看到的工作区，按 `?workspace=<slug>` 选中，没带就落到会话里记住的那个。
 *
 * 项目页与项目经理页共用这一份，避免两个页面各写一套「第一个工作区」「没工作区怎么办」。
 */
import type { Role } from "@/lib/auth/roles";
import { requirePageAuth } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";
import { pickActiveWorkspace } from "@/lib/auth/workspaces";

export type WorkspaceOption = {
  id: string;
  slug: string;
  name: string;
  role: Role;
};

export type WorkspaceScope = {
  account: { displayName: string; email: string; isPlatformAdmin: boolean };
  /** 当前账号在当前工作区里的角色。 */
  role: Role;
  workspaces: WorkspaceOption[];
  /** 当前选中的工作区；账号一个工作区都没有时为 `null`。 */
  active: WorkspaceOption | null;
  /** 带当前工作区参数的查询串（`""` 或 `?workspace=xxx`），页面拼链接时直接用。 */
  query: string;
};

export async function resolveWorkspaceScope(
  nextPath: string,
  requestedSlug: string | undefined,
): Promise<WorkspaceScope> {
  const auth = await requirePageAuth(nextPath);
  const workspaces = await listWorkspacesForAccount(auth.account.id, auth.account.isPlatformAdmin);

  const active = pickActiveWorkspace(workspaces, {
    requestedSlug,
    sessionWorkspaceId: auth.workspaceId,
  });

  return {
    account: {
      displayName: auth.account.displayName,
      email: auth.account.email,
      isPlatformAdmin: auth.account.isPlatformAdmin,
    },
    role: active?.role ?? auth.role,
    workspaces,
    active,
    query: active === null ? "" : `?workspace=${encodeURIComponent(active.slug)}`,
  };
}

/**
 * 「是否渲染工作区切换器」的唯一一份判定活在 `lib/auth/workspaces.ts` 里（纯函数，能单测）。
 * 这里原样转出，页面继续只从本文件取受保护页面共用的东西。
 */
export { showsWorkspaceSwitcher } from "@/lib/auth/workspaces";
