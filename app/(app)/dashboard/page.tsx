/**
 * 工作台：受保护页面，未登录会被 `requirePageAuth` 跳转到登录页。
 *
 * 页面本身不做角色判断——它展示什么都由服务端算好，接口的权限由 `requireRole` 把关，
 * 前端拿到的只是一个已经过滤过的清单。
 */
import type { Metadata } from "next";

import { ROLE_LABELS } from "@/lib/auth/roles";
import { requirePageAuth } from "@/lib/auth/server";
import { listWorkspaceProjects, listWorkspacesForAccount } from "@/lib/auth/store";
import { styles } from "../../styles";
import { InviteMemberForm, LogoutButton, WorkspaceSwitcher } from "./controls";

export const metadata: Metadata = { title: "工作台 · CRP 提测平台" };

export default async function DashboardPage() {
  const auth = await requirePageAuth("/dashboard");
  const workspaces = await listWorkspacesForAccount(
    auth.account.id,
    auth.account.isPlatformAdmin,
  );
  const active = workspaces.find((workspace) => workspace.id === auth.workspaceId) ?? null;
  const projects = active === null ? [] : await listWorkspaceProjects(active.id);

  return (
    <main style={styles.page}>
      <section style={styles.wideCard}>
        <div style={styles.row}>
          <h1 style={styles.title}>
            {auth.account.displayName}（{ROLE_LABELS[auth.role]}）
          </h1>
          <LogoutButton />
        </div>
        <p style={styles.hint}>{auth.account.email}</p>

        <div style={styles.section}>
          <h2 style={{ ...styles.title, fontSize: 16 }}>工作区</h2>
          <WorkspaceSwitcher
            workspaces={workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
              role: workspace.role,
            }))}
            activeId={active?.id ?? null}
          />
        </div>

        <div style={styles.section}>
          <h2 style={{ ...styles.title, fontSize: 16 }}>
            {active === null ? "项目" : `项目（${active.name}）`}
          </h2>
          {active === null ? (
            <p style={styles.hint}>先选一个工作区，再看它下面的项目。</p>
          ) : projects.length === 0 ? (
            <p style={styles.hint}>这个工作区还没有项目。</p>
          ) : (
            <ul style={styles.list}>
              {projects.map((project) => (
                <li key={project.id} style={styles.row}>
                  <span>{project.name}</span>
                  <code>{project.key}</code>
                </li>
              ))}
            </ul>
          )}
        </div>

        {auth.account.isPlatformAdmin && active !== null ? (
          <div style={styles.section}>
            <h2 style={{ ...styles.title, fontSize: 16 }}>邀请成员到「{active.name}」</h2>
            <p style={styles.hint}>
              邮箱已有账号时只补成员关系，不改原密码；没有账号时按填写的初始密码建号。
            </p>
            <InviteMemberForm workspaceId={active.id} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
