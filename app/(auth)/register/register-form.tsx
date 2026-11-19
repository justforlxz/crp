"use client";

/**
 * 注册表单：提交到 `POST /api/auth/register`，成功后直接进入工作台（注册即登录）。
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readErrorMessage } from "../../http-error";

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
      <label className="field-label" htmlFor="displayName">
        姓名
      </label>
      <input id="displayName" name="displayName" required className="input" />

      <label className="field-label" htmlFor="email">
        邮箱
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        className="input"
      />

      <label className="field-label" htmlFor="password">
        密码（至少 8 位）
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        className="input"
      />

      {error === null ? null : <p className="alert alert--error">{error}</p>}

      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
        {pending ? "注册中…" : "注册"}
      </button>
    </form>
  );
}
