import type { ReactNode } from "react";

import { AppNav } from "@/components/page-shell";
import { ROLE_LABELS, accountRole } from "@/lib/auth/roles";
import { peekSession } from "@/lib/auth/server";

/**
 * 受保护页面的外壳（A19）。
 *
 * 只做两件事：把侧栏导航挂一次（含底部的账号区），页面内容放进右侧内容区。页面自己只需要用
 * `PageShell` 交出标题与内容，不重复写外层结构，也不各写一套导航。
 *
 * 账号区读会话在这里做：侧栏是客户端组件，读 Cookie 只能留在服务端。未登录时
 * `peekSession` 给 `null`，侧栏照常出导航，页面自己的 `requirePageAuth` 会跳登录页。
 * 顺带一个结果：`(app)` 下的页面从此都按请求渲染，静态预渲染时不会把账号信息烤进产物。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const account = await peekSession();

  return (
    <div className="app-layout">
      <AppNav
        account={
          account === null
            ? null
            : {
                displayName: account.displayName,
                roleLabel: ROLE_LABELS[accountRole(account.isPlatformAdmin)],
                email: account.email,
              }
        }
      />
      <div className="app-body">{children}</div>
    </div>
  );
}
