/**
 * 登录页。已登录直接进工作台；`next` 只接受站内路径，避免被当成跳转跳板。
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { peekSession } from "@/lib/auth/server";
import { styles } from "../../styles";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录 · CRP 提测平台" };

/** 回跳地址只认站内路径：`/` 开头且不是 `//`（协议相对地址）。 */
function safeNext(next: string | undefined): string {
  if (typeof next === "string" && next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }

  return "/dashboard";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if ((await peekSession()) !== null) {
    redirect("/dashboard");
  }

  const { next } = await searchParams;

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <h1 style={styles.title}>登录</h1>
        <p style={styles.hint}>用平台账号登录。账号由平台管理员邀请，或自行注册。</p>
        <LoginForm nextPath={safeNext(next)} />
        <p style={styles.hint}>
          还没有账号？<Link href="/register">注册一个</Link>
        </p>
      </section>
    </main>
  );
}
