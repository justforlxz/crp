"use client";

/**
 * 工作台上的两个操作：切换工作区、邀请成员（仅平台管理员）。
 *
 * 都是先调接口、成功后再 `router.refresh()` 让服务端组件重新取数，不在前端保存一份状态副本。
 * 退出登录不在这里：它在侧栏底部的账号区（`components/page-shell.tsx`），任何页面都点得到。
 *
 * 样式只用外壳与表单那套现成的件：工作区切换器是一个 `.select`，邀请表单是 `.field` +
 * `.input` + `.btn`。不另起一套控件外观（界面规范 v2 第七节「表单」）。
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import { readErrorMessage } from "../../http-error";

type WorkspaceOption = { id: string; name: string; role: Role };

/** 工作区切换器：选中即切换，切完刷新页面数据。 */
export function WorkspaceSwitcher({
  workspaces,
  activeId,
}: {
  workspaces: WorkspaceOption[];
  /** 当前工作区。调用方只在「已经选中一个工作区」时渲染这个组件，所以不会是 null。 */
  activeId: string;
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
    return <p className="hint">当前账号还没有加入任何工作区，请联系平台管理员分配。</p>;
  }

  // 顶栏只有 56px（design.md 第四节），所以这里不能再叠一行标签：一个 40px 的下拉，
  // 名字交给 aria-label，选中项本身就写着当前工作区。
  return (
    <span data-style-anchor="dashboard.workspace-switcher">
      <select
        id="dashboard-workspace"
        className="select"
        aria-label="工作区"
        value={activeId}
        disabled={pending !== null}
        onChange={(event) => void handleSwitch(event.target.value)}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}（{ROLE_LABELS[workspace.role]}）
          </option>
        ))}
      </select>
      {error === null ? null : (
        <span className="hint" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** 邀请成员：邮箱已存在时只补成员关系，新邮箱按填写的初始密码建号。 */
export function InviteMemberForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

    setNotice("成员已加入这个工作区。");
    event.currentTarget.reset();
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="form-row2">
      <label className="field">
        <span className="label">邮箱</span>
        <input className="input" id="invite-email" name="email" type="email" required />
      </label>

      <label className="field">
        <span className="label">显示名</span>
        <input className="input" id="invite-name" name="displayName" required />
      </label>

      <label className="field">
        <span className="label">初始密码</span>
        <input
          className="input"
          id="invite-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
        />
        <span className="note">邮箱已有账号时忽略这一项，不改原密码。</span>
      </label>

      <label className="field">
        <span className="label">角色</span>
        <select className="select" id="invite-role" name="role" defaultValue="developer">
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "提交中…" : "邀请成员"}
        </button>
        {error === null ? null : (
          <span className="note" role="alert">
            {error}
          </span>
        )}
        {notice === null ? null : (
          <span className="note" role="status">
            {notice}
          </span>
        )}
      </div>
    </form>
  );
}
