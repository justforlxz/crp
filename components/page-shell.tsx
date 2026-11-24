"use client";

/**
 * 全站外壳：侧栏 + 顶栏 + 画布（界面规范 v2 第二节、第七节）。
 *
 * 原型把外壳写成三层，这里照搬，不做合并：
 *
 * - `.shell` 是整页的网格（216px 侧栏 + 内容区），由 `app/(app)/layout.tsx` 挂一次；
 * - `.sidebar` 是侧栏（品牌、两组导航、底部账号区），也由 layout 挂一次；
 * - `.topbar` + `.canvas` 属于**每个页面**：页面标题住在顶栏，所以标题、一句话说明与主操作
 *   只能由页面交给 `PageShell`，再由它渲染成顶栏与内容区。内容区不再放 `<h1>`（design.md 第三条）。
 *
 * 为什么侧栏是客户端组件：高亮要跟着当前网址走，而服务端的 layout 拿不到路径。
 * 徽标数字由 layout 在服务端查好再交下来（`lib/stats/nav.ts`），这里只负责显示。
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "./icons";
import type { NavCounts } from "@/lib/stats/nav";

type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** 要显示徽标时取哪个数字；不写就是不显示徽标。 */
  countKey?: keyof NavCounts;
};

type NavGroup = { label: string; items: readonly NavItem[] };

/** 侧栏的两组导航。顺序就是用户在页面上的阅读顺序，与原型一致。 */
export const APP_NAV: readonly NavGroup[] = [
  {
    label: "工作区",
    items: [
      { href: "/dashboard", label: "工作台", icon: "dashboard" },
      { href: "/releases", label: "提测记录", icon: "releases", countKey: "releases" },
      { href: "/queue", label: "构建队列", icon: "queue", countKey: "queue" },
    ],
  },
  {
    label: "配置",
    items: [
      { href: "/projects", label: "项目", icon: "projects" },
      { href: "/managers", label: "项目经理", icon: "managers" },
      { href: "/packages", label: "软件包", icon: "packages" },
      { href: "/baselines", label: "基线", icon: "baselines" },
      { href: "/webhooks", label: "Webhook", icon: "webhook" },
    ],
  },
];

/**
 * 当前地址是否落在这一项上。
 *
 * 只认「完全相等」或「后面紧跟一个 `/`」：`/releases` 不该把 `/releases-archive` 这类
 * 前缀相近的地址也算进来，但 `/releases/new` 与 `/releases/<id>` 都算提测记录。
 */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 侧栏底部账号区要显示的三样。
 *
 * 由服务端的 `app/(app)/layout.tsx` 从会话里取好再交下来：侧栏是客户端组件，读会话留在服务端。
 */
export type SidebarAccountInfo = {
  displayName: string;
  roleLabel: string;
  email: string;
};

/** 头像里的那个字：取显示名的第一个字符，没有名字就用邮箱首字母。 */
function avatarText(account: SidebarAccountInfo): string {
  const first = Array.from(account.displayName.trim())[0] ?? Array.from(account.email)[0] ?? "?";

  return first.toUpperCase();
}

/** 退出登录：撤销会话后回登录页。放在侧栏底部，任何受保护页面都点得到。 */
function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick(): Promise<void> {
    setPending(true);
    await fetch("/api/auth/logout", { method: "POST" });
    setPending(false);
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" className="nav-item" onClick={handleClick} disabled={pending}>
      <Icon name="arrow-left" />
      <span>{pending ? "退出中…" : "退出登录"}</span>
    </button>
  );
}

/** 侧栏底部的账号区：头像、账号名、角色与退出登录。 */
function SidebarAccount({ account }: { account: SidebarAccountInfo }) {
  return (
    <div className="sidebar-foot" data-style-anchor="sidebar.account">
      <div className="account" title={account.email}>
        <span className="avatar" aria-hidden="true">
          {avatarText(account)}
        </span>
        <div>
          <div className="account-name">{account.displayName}</div>
          <div className="account-role">{account.roleLabel}</div>
        </div>
      </div>
      <LogoutButton />
    </div>
  );
}

/**
 * 受保护页面的侧栏。只有 `(app)` 路由组挂它，登录注册页走 `PageShell` 的 auth 版式。
 *
 * `account` 为 `null` 表示这次渲染还没拿到会话（未登录时页面自己会跳登录页）：
 * 导航照常出，账号区不出。`counts` 为 `null` 时徽标不显示 —— 宁可不显示，也不填一个猜的数字。
 */
export function AppNav({
  account,
  counts,
}: {
  account: SidebarAccountInfo | null;
  counts: NavCounts | null;
}) {
  const pathname = usePathname() ?? "";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <Icon name="logo" />
        </div>
        <div>
          <div className="brand-name">提测平台</div>
          <div className="brand-sub">Release Hub</div>
        </div>
      </div>

      <nav aria-label="主导航">
        {APP_NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const count = item.countKey === undefined ? null : (counts?.[item.countKey] ?? null);

              return (
                <Link
                  key={item.href}
                  className="nav-item"
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  data-style-anchor={`nav.${item.href.slice(1)}`}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {count === null ? null : <span className="nav-count num">{count}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {account === null ? null : <SidebarAccount account={account} />}
    </aside>
  );
}

export type PageShellProps = {
  /** 页面标题，住在顶栏（design.md 第三节第三条）。 */
  title: ReactNode;
  /** 顶栏里那句说明，缺省不显示。 */
  description?: ReactNode;
  /** 顶栏右侧的主操作。 */
  actions?: ReactNode;
  /**
   * 版式：
   * - `default`：受保护页面，顶栏 + 内容区；
   * - `auth`：登录、注册，只有一张居中的窄卡片，没有顶栏与侧栏。
   */
  variant?: "default" | "auth";
  children: ReactNode;
};

/**
 * 单个页面的外壳。页面根元素只有它，不许自己写 `<header>` / `<main>`。
 *
 * 内容区顺序：`.canvas`（内边距 24px 32px 80px）→ `.wrap`（最大宽 1400px 居中）→ 页面内容。
 */
export function PageShell({
  title,
  description,
  actions,
  variant = "default",
  children,
}: PageShellProps) {
  if (variant === "auth") {
    return (
      <main className="canvas">
        <div className="wrap">
          <div className="page page--auth">
            <div className="panel">
              <div className="panel-hd">
                <h2>{title}</h2>
              </div>
              <div className="panel-bd">{children}</div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">{title}</div>
        {description === undefined ? null : <div className="topbar-desc">{description}</div>}
        <div className="topbar-actions">{actions}</div>
      </header>

      <main className="canvas">
        <div className="wrap">
          <div className="page">{children}</div>
        </div>
      </main>
    </>
  );
}
