/**
 * 注册页。已登录直接进工作台。
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { peekSession } from "@/lib/auth/server";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "注册 · CRP 提测平台" };

export default async function RegisterPage() {
  if ((await peekSession()) !== null) {
    redirect("/dashboard");
  }

  return (
    <PageShell title="注册" variant="auth">
      <p className="hint">
        注册后账号不属于任何工作区，需要平台管理员把账号加入工作区才能看到项目。
      </p>
      <RegisterForm />
      <p className="hint">
        已经有账号？<Link href="/login">去登录</Link>
      </p>
    </PageShell>
  );
}
