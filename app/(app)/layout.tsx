import type { ReactNode } from "react";

import { AppNav } from "@/components/page-shell";

/**
 * 受保护页面的外壳（A19）。
 *
 * 只做一件事：把侧栏导航挂一次，页面内容放进右侧内容区。页面自己只需要用 `PageShell`
 * 交出标题与内容，不重复写外层结构，也不各写一套导航。
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <AppNav />
      <div className="app-body">{children}</div>
    </div>
  );
}
