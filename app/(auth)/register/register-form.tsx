"use client";

/**
 * 注册表单：提交到 `POST /api/auth/register`，成功后直接进入工作台（注册即登录）。
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readErrorMessage } from "../../http-error";
import { styles } from "../../styles";

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        displayName: form.get("displayName"),
        password: form.get("password"),
      }),
    });

    setPending(false);

    if (!response.ok) {
      setError(await readErrorMessage(response, "注册失败"));
      return;
    }

    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label style={styles.label} htmlFor="displayName">
        姓名
      </label>
      <input id="displayName" name="displayName" required style={styles.input} />

      <label style={styles.label} htmlFor="email">
        邮箱
      </label>
      <input id="email" name="email" type="email" autoComplete="username" required style={styles.input} />

      <label style={styles.label} htmlFor="password">
        密码（至少 8 位）
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        style={styles.input}
      />

      {error === null ? null : <p style={styles.error}>{error}</p>}

      <button type="submit" style={styles.button} disabled={pending}>
        {pending ? "注册中…" : "注册"}
      </button>
    </form>
  );
}
