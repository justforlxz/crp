"use client";

/**
 * 「我的账号」里一个区块：一套外部系统的用户名、密码与「保存并验证」。
 *
 * 为什么这一步必须在客户端做：保存要等一次真实登录的外部请求（可能几秒），页面得显示
 * 「处理中…」并原地显示失败原因，而不是整页刷新。校验本身仍在服务端（API 先真登录再入库），
 * 这里只负责把结果贴回来。
 *
 * 密码框永远是空的：接口不回传密码，用户要改就重填一次。这是有意的 —— 页面上放一个
 * 「已保存的密码」等于把明文又送回浏览器。
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Toast } from "@/components/toast";
import type { CredentialView } from "@/lib/credentials";

import { readErrorMessage } from "../../../http-error";

/** 时间统一按 UTC 显示并标出来，与全站其它页面一致。 */
function formatCredentialTime(value: Date | null): string {
  if (value === null) {
    return "从未验证成功";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function CredentialPanel({
  view,
  secretLabel,
}: {
  view: CredentialView;
  /** 密码这一栏叫什么：CRP 是 LDAP 密码，Gerrit 是 HTTP 密码。 */
  secretLabel: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState(view.username ?? "");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const configured = view.configured;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: view.kind, username, secret }),
      });

      if (!response.ok) {
        setError(await readErrorMessage(response, "保存没成功，请稍后重试。"));
        return;
      }

      // 使密码框回到空、把服务端刚验证过的时间刷出来。
      setSecret("");
      setNotice(`${view.label}已保存，验证通过。`);
      router.refresh();
    } catch {
      setError("连不上服务器，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<void> {
    // 破坏性操作：先确认，文案写清影响范围（design.md 第九节）。
    const confirmed = window.confirm(
      `删除${view.label}之后，创建提测、投递构建、刷新代码状态都会停下来，直到你重新配置。继续删除？`,
    );

    if (!confirmed) {
      return;
    }

    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/settings/credentials?kind=${encodeURIComponent(view.kind)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        setError(await readErrorMessage(response, "删除没成功，请稍后重试。"));
        return;
      }

      setUsername("");
      setSecret("");
      setNotice(`${view.label}已删除。`);
      router.refresh();
    } catch {
      setError("连不上服务器，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{view.label}</h2>
        <span className="hint">
          {configured ? `最后验证：${formatCredentialTime(view.verifiedAt)}` : "还没有配置"}
        </span>
        <div className="spacer" />
        <span className={configured ? "dot is-ok" : "dot is-wait"}>
          {configured ? "已配置" : "未配置"}
        </span>
      </div>

      <div className="panel-bd">
        {configured ? (
          <p>
            当前账号：<b>{view.username}</b>。要换账号或改密码，重新填一遍再保存即可；密码不会回显。
          </p>
        ) : (
          <p>填上你自己的账号与密码。保存时平台会用这组凭据真实登录一次，通过才入库。</p>
        )}

        {view.lastError === null ? null : (
          <p role="alert">
            <b>上次验证没通过：</b>
            {view.lastError}
          </p>
        )}

        <form onSubmit={submit}>
          <label className="field">
            <span className="label">用户名</span>
            <input
              className="input"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="field">
            <span className="label">{secretLabel}</span>
            <input
              className="input"
              name="secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="current-password"
              required
            />
            <span className="note">
              只存密文（AES-256-GCM），不落明文、不回传，也不会写进任何日志。
            </span>
          </label>

          <p>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "验证中…" : "保存并验证"}
            </button>
            {configured ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={remove}
                disabled={pending}
              >
                删除
              </button>
            ) : null}
          </p>
        </form>

        {/* 版式按 `.agents/spec/design/prototype.html` 的 `.toast.ok` / `.toast.bad`。 */}
        <Toast className="toast bad" role="alert" message={error} />
        <Toast className="toast ok" message={notice} />
      </div>
    </div>
  );
}
