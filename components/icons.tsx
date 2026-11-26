/**
 * 原型那套线性图标（`.agents/spec/design/prototype.html` 顶部的 `<symbol>` 定义）。
 *
 * 原型用 `<symbol>` + `<use href="#i-x">` 拼图标：所有图形定义一次，页面上只写引用。这里改成
 * 每个图标一份内联 `<svg>`，理由有两条：
 *
 * 1. `<use>` 依赖同一份文档里的 id，登录、注册这两个不挂控制台外壳的页面会拿不到图形；
 * 2. 内联不引入全局 id，服务端渲染与客户端渲染的结果一致，也不会出现「图标第一次没画出来」。
 *
 * 尺寸由样式表决定（`.nav-item svg`、`.btn svg`、`.stat-ico svg` 各自给了宽高），
 * 这里只负责图形本身，不写内联 style。
 */

import type { ReactElement } from "react";

/** 图标名与原型 `#i-<名字>` 的后半段一致。 */
export const ICON_NAMES = [
  "logo",
  "dashboard",
  "releases",
  "queue",
  "projects",
  "managers",
  "packages",
  "baselines",
  "webhook",
  "search",
  "plus",
  "download",
  "check",
  "x",
  "alert",
  "info",
  "clock",
  "cpu",
  "box",
  "refresh",
  "arrow-left",
  "chevron",
  "more",
  "empty",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const ICONS: Record<IconName, ReactElement> = {
  "logo": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/>
      <path d="m3 12 9 4.5 9-4.5"/>
      <path d="m3 16.5 9 4.5 9-4.5"/>
    </svg>
  ),
  "dashboard": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5"/>
      <rect x="14" y="3" width="7" height="5" rx="1.5"/>
      <rect x="14" y="12" width="7" height="9" rx="1.5"/>
      <rect x="3" y="16" width="7" height="5" rx="1.5"/>
    </svg>
  ),
  "releases": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8v10a2 2 0 0 1-1.6 1.96l-7 1.4A2 2 0 0 1 10 19.4V9"/>
      <path d="M3 5.6a2 2 0 0 1 1.6-1.96l7-1.4A2 2 0 0 1 14 4.2v10.4"/>
      <path d="M7 8.5 3 6.5M7 13.5 3 11.5"/>
    </svg>
  ),
  "queue": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2.5-6 4 12L16 12h5"/>
    </svg>
  ),
  "projects": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>
    </svg>
  ),
  "managers": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2"/>
      <path d="M3 20a6 6 0 0 1 12 0"/>
      <path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6 6 0 0 0-1.6-4.1"/>
    </svg>
  ),
  "packages": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 8.4v7.2a2 2 0 0 1-1.05 1.76l-6 3.2a2 2 0 0 1-1.9 0l-6-3.2A2 2 0 0 1 4 15.6V8.4"/>
      <path d="m4.3 7.5 7-3.4a2 2 0 0 1 1.8 0l7 3.4-7.7 4-7.4-3.7Z"/>
      <path d="M12 12v9"/>
    </svg>
  ),
  "baselines": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.5" cy="5" r="2.3"/>
      <circle cx="6.5" cy="19" r="2.3"/>
      <circle cx="17.5" cy="9" r="2.3"/>
      <path d="M6.5 7.3v9.4M17.5 11.3c0 3.2-2.5 4.4-6 5.2"/>
    </svg>
  ),
  "webhook": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 6.5a3 3 0 0 1 5 2.2c0 .9-.4 1.6-1 2.3l2.6 4.4"/>
      <path d="M14.5 17.5a3 3 0 0 1-5-2.2c0-.9.4-1.6 1-2.3L7.9 8.6"/>
      <path d="M6 14a3 3 0 0 0 2.6 4.5h6.8A3 3 0 0 0 18 14"/>
    </svg>
  ),
  "search": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5"/>
      <path d="m16 16 4.5 4.5"/>
    </svg>
  ),
  "plus": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  ),
  "download": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v10M8 11l4 4 4-4"/>
      <path d="M4 19h16"/>
    </svg>
  ),
  "check": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7"/>
    </svg>
  ),
  "x": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18"/>
    </svg>
  ),
  "alert": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4.5 3.2 19.5h17.6L12 4.5Z"/>
      <path d="M12 10v4M12 17h.01"/>
    </svg>
  ),
  "info": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5"/>
      <path d="M12 11v5.5M12 7.8h.01"/>
    </svg>
  ),
  "clock": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5"/>
      <path d="M12 7.5V12l3 1.8"/>
    </svg>
  ),
  "cpu": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="10" height="10" rx="2"/>
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>
    </svg>
  ),
  "box": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3"/>
      <path d="M4 10h16M10 10v10"/>
    </svg>
  ),
  "refresh": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12a8 8 0 1 1-2.6-5.9"/>
      <path d="M20 4v5h-5"/>
    </svg>
  ),
  "arrow-left": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M11 6l-6 6 6 6"/>
    </svg>
  ),
  "chevron": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6"/>
    </svg>
  ),
  "more": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="6" cy="12" r="1.7"/>
      <circle cx="12" cy="12" r="1.7"/>
      <circle cx="18" cy="12" r="1.7"/>
    </svg>
  ),
  "empty": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="6" width="17" height="14" rx="2.5"/>
      <path d="M3.5 11h17M8 3.5v4M16 3.5v4"/>
    </svg>
  ),
};

/** 取一个原型图标。装饰性图形，不参与读屏。 */
export function Icon({ name }: { name: IconName }): ReactElement {
  return ICONS[name];
}
