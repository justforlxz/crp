"use client";

/**
 * 工作台上的三个操作：切换工作区、退出登录、邀请成员（仅平台管理员）。
 *
 * 都是先调接口、成功后再 `router.refresh()` 让服务端组件重新取数，不在前端保存一份状态副本。
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import { readErrorMessage } from "../../http-error";
import { styles } from "../../styles";

type WorkspaceOption = { id: string; name: string; role: Role };

export function LogoutButton() {
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
    <button type="button" style={styles.smallButton} onClick={handleClick} disabled={pending}>
      {pending ? "退出中…" : "退出登录"}
    </button>
  );
}

export function WorkspaceSwitcher({
  workspaces,
  activeId,
}: {
  workspaces: WorkspaceOption[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSwitch(workspaceId: string): Promise<void> {
    setPending(workspaceId);
    setError(null);

    const response = await fetch(`/api/workspaces/${workspaceId}/switch`, { method: "POST" });

    setPending(null);

    if (!response.ok) {
      setError(await readErrorMessage(response, "切换工作区失败"));
      return;
    }

    router.refresh();
  }

  if (workspaces.length === 0) {
    return <p style={styles.hint}>当前账号还没有加入任何工作区，请联系平台管理员分配。</p>;
  }

  return (
    <>
      <ul style={styles.list}>
        {workspaces.map((workspace) => (
          <li key={workspace.id} style={styles.row}>
            <span>
              {workspace.name}（{ROLE_LABELS[workspace.role]}）
            </span>
            {workspace.id === activeId ? (
              <strong>当前</strong>
            ) : (
              <button
                type="button"
                style={styles.smallButton}
                onClick={() => handleSwitch(workspace.id)}
                disabled={pending !== null}
              >
                {pending === workspace.id ? "切换中…" : "切换到这里"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error === null ? null : <p style={styles.error}>{error}</p>}
    </>
  );
}

export function InviteMemberForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setNotice(null);

    const response = await fetch(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        displayName: form.get("displayName"),
        password: form.get("password"),
        role: form.get("role"),
      }),
    });

    setPending(false);

    if (!response.ok) {
      setError(await readErrorMessage(response, "邀请失败"));
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { accountCreated?: boolean }
      | null;
    setNotice(
      body?.accountCreated === false
        ? "已把已有账号加入工作区（原密码不变）"
        : "已建号并加入工作区",
    );
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label style={styles.label} htmlFor="member-displayName">
        姓名
      </label>
      <input id="member-displayName" name="displayName" style={styles.input} />

      <label style={styles.label} htmlFor="member-email">
        邮箱
      </label>
      <input id="member-email" name="email" type="email" required style={styles.input} />

      <label style={styles.label} htmlFor="member-password">
        初始密码（新账号必填，至少 8 位）
      </label>
      <input
        id="member-password"
        name="password"
        type="password"
        style={styles.input}
      />

      <label style={styles.label} htmlFor="member-role">
        角色
      </label>
      <select id="member-role" name="role" defaultValue="developer" style={styles.input}>
        <option value="project_manager">项目经理</option>
        <option value="developer">开发者</option>
        <option value="reader">只读成员</option>
      </select>

      {error === null ? null : <p style={styles.error}>{error}</p>}
      {notice === null ? null : <p style={styles.hint}>{notice}</p>}

      <button type="submit" style={styles.button} disabled={pending}>
        {pending ? "提交中…" : "建号并加入工作区"}
      </button>
    </form>
  );
}
