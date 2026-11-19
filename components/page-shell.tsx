"use client";

/**
 * 页面外壳（A19）：侧栏导航 + 内容区容器 + 当前页高亮。
 *
 * 全站只有这一处定义外层结构，页面只交出内容，不自己写 `<body>` / `<main>`：
 *
 * - `AppNav` 由 `app/(app)/layout.tsx` 挂一次，`usePathname()` 决定哪一项高亮；
 * - `PageShell` 由每个 `page.tsx` 收敛内容：有标题就先出 `<h1>`，登录注册另用 `variant="auth"`；
 * - 样式只从 `app/globals.css` 来，这里不写任何内联 `style`。
 *
 * 为什么是客户端组件：高亮要跟着当前网址走，而 App Router 的服务端 layout 拿不到路径。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** 侧栏导航项：地址与显示名。顺序就是用户在页面上的阅读顺序。 */
export const APP_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/dashboard", label: "工作台" },
  { href: "/projects", label: "项目" },
  { href: "/managers", label: "项目经理" },
  { href: "/packages", label: "软件包" },
  { href: "/baselines", label: "基线" },
  { href: "/releases", label: "提测记录" },
  { href: "/queue", label: "构建队列" },
  { href: "/webhooks", label: "Webhook" },
];

/**
 * 当前地址是否落在这一项上。
 *
 * 只认「完全相等」或「后面紧跟一个 `/`」：`/releases` 不该把 `/releases/new` 之外的
 * 前缀相近地址（例如将来的 `/releases-archive`）也算进来。
 */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 受保护页面的侧栏。只有 `(app)` 路由组挂它，登录注册页走 PageShell 的 auth 版式。 */
export function AppNav() {
  const pathname = usePathname() ?? "";

  return (
    <aside className="app-sidebar">
      <p className="app-sidebar__brand">CRP 提测平台</p>
      <nav aria-label="主导航">
        <ul className="app-nav__list">
          {APP_NAV.map((item) => (
            <li key={item.href}>
              <Link
                className="app-nav__link"
                href={item.href}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
                data-style-anchor={`nav.${item.href.slice(1)}`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

export type PageShellProps = {
  /** 页面标题，对应页面原来的那一行 `<h1>`。可以是节点，例如带标识的标题。 */
  title: ReactNode;
  /** 标题右侧的操作区，例如刷新按钮。 */
  actions?: ReactNode;
  /**
   * 版式：
   * - `default`：受保护页面，内容占满内容区；
   * - `auth`：登录、注册与占位页，内容收在一张居中卡片里。
   */
  variant?: "default" | "auth";
  children: ReactNode;
};

/** 单个页面的内容容器。页面根元素只有它，不许自己写 `<main>`。 */
export function PageShell({ title, actions, variant = "default", children }: PageShellProps) {
  const header = (
    <div className="page__header">
      <h1>{title}</h1>
      {actions === undefined ? null : <div className="page__actions">{actions}</div>}
    </div>
  );

  if (variant === "auth") {
    return (
      <main className="page page--auth">
        <section className="card">
          {header}
          {children}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      {header}
      {children}
    </main>
  );
}
