"use client";

/**
 * 登录表单：提交到 `POST /api/auth/login`，成功后跳回 `next` 指定的页面。
 *
 * 校验与限流都在服务端；这里只把服务端返回的错误文案显示出来，不重复实现规则。
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readErrorMessage } from "../../http-error";
import { styles } from "../../styles";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });

    setPending(false);

    if (!response.ok) {
      setError(await readErrorMessage(response, "登录失败"));
      return;
    }

    router.replace(nextPath);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label style={styles.label} htmlFor="email">
        邮箱
      </label>
      <input id="email" name="email" type="email" autoComplete="username" required style={styles.input} />

      <label style={styles.label} htmlFor="password">
        密码
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        style={styles.input}
      />

      {error === null ? null : <p style={styles.error}>{error}</p>}

      <button type="submit" style={styles.button} disabled={pending}>
        {pending ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
