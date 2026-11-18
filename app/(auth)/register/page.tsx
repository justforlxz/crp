/**
 * 注册页。已登录直接进工作台。
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { peekSession } from "@/lib/auth/server";
import { styles } from "../../styles";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "注册 · CRP 提测平台" };

export default async function RegisterPage() {
  if ((await peekSession()) !== null) {
    redirect("/dashboard");
  }

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <h1 style={styles.title}>注册</h1>
        <p style={styles.hint}>
          注册后账号不属于任何工作区，需要平台管理员把账号加入工作区才能看到项目。
        </p>
        <RegisterForm />
        <p style={styles.hint}>
          已经有账号？<Link href="/login">去登录</Link>
        </p>
      </section>
    </main>
  );
}
