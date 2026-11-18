import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "CRP 提测平台（Release Hub）",
  description: "在 CRP 之上提供项目化提测归属、按依赖排队与可审计的提测快照。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
