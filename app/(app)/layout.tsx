import type { ReactNode } from "react";

import { AppNav } from "@/components/page-shell";
import { ROLE_LABELS, accountRole } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";
import { pickActiveWorkspace } from "@/lib/auth/workspaces";
import { loadNavCounts, type NavCounts } from "@/lib/stats";

/**
 * 受保护页面的外壳（界面规范 v2 第二节）：整页网格只在这里定义一次。
 *
 * 只做两件事：
 *
 * 1. 把侧栏挂一次 —— 品牌、两组导航、底部账号区，任何受保护页面都共用这一份；
 * 2. 把页面内容放进 `.main`，页面自己再用 `PageShell` 交出顶栏（标题、说明、主操作）与内容区。
 *
 * 账号与徽标数字都在这里读：侧栏是客户端组件，读会话与查数据库只能留在服务端。未登录时
 * `readSession` 给 `null`，侧栏照常出导航、不出账号区，页面自己的 `requirePageAuth` 会跳登录页。
 * 顺带一个结果：`(app)` 下的页面从此都按请求渲染，静态预渲染时不会把账号信息烤进产物。
 *
 * 徽标按**会话记住的工作区**算，因为侧栏链接不带 `?workspace=`：点下去落到的就是这个工作区，
 * 徽标要和目标页面数得上（口径见 `lib/stats/nav.ts`）。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const current = await readSession();

  let account: { displayName: string; roleLabel: string; email: string } | null = null;
  let counts: NavCounts | null = null;

  if (current !== null) {
    const workspaces = await listWorkspacesForAccount(
      current.account.id,
      current.account.isPlatformAdmin,
    );
    const active = pickActiveWorkspace(workspaces, {
      sessionWorkspaceId: current.session.activeWorkspaceId,
    });

    account = {
      displayName: current.account.displayName,
      roleLabel: ROLE_LABELS[accountRole(current.account.isPlatformAdmin)],
      email: current.account.email,
    };
    counts = active === null ? null : await loadNavCounts(active.id);
  }

  return (
    <div className="shell">
      <AppNav account={account} counts={counts} />
      <div className="main">{children}</div>
    </div>
  );
}
