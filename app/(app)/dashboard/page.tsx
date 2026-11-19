/**
 * 工作台：受保护页面，未登录会被 `requirePageAuth` 跳转到登录页。
 *
 * 页面本身不做角色判断，也不自己数数：统计卡、最近提测、队列摘要、项目概况、配置待办
 * 全部由 `lib/stats` 的 `loadDashboard` 一次读出来，数字都是数据库聚合查询的结果。
 * 切工作区（A6 建的那个控件）后服务端组件重新取数，因此数字只反映当前工作区。
 *
 * 口径写在「概览」的副标题上：本周 = 最近 7 天。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { ROLE_LABELS } from "@/lib/auth/roles";
import { requirePageAuth } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";
import { formatDuration } from "@/lib/build";
import { loadDashboard, STATS_WINDOW_DAYS } from "@/lib/stats";
import { styles } from "../../styles";
import { InviteMemberForm, LogoutButton, WorkspaceSwitcher } from "./controls";

export const metadata: Metadata = { title: "工作台 · CRP 提测平台" };

// 统计数字每次进页面都要现算，不做静态化。
export const dynamic = "force-dynamic";

/** 与构建队列页同一套时间口径：一律按 UTC 展示。 */
function formatTime(value: Date | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default async function DashboardPage() {
  const auth = await requirePageAuth("/dashboard");
  const workspaces = await listWorkspacesForAccount(
    auth.account.id,
    auth.account.isPlatformAdmin,
  );
  const active = workspaces.find((workspace) => workspace.id === auth.workspaceId) ?? null;
  const stats = active === null ? null : await loadDashboard(active.id);

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

        {stats === null ? (
          <div style={styles.section}>
            <h2 style={{ ...styles.title, fontSize: 16 }}>概览</h2>
            <p style={styles.hint}>先选一个工作区，再看它的提测统计。</p>
          </div>
        ) : (
          <>
            <div style={styles.section}>
              <h2 style={{ ...styles.title, fontSize: 16 }}>概览</h2>
              <p style={styles.hint}>
                口径：本周 = 最近 {STATS_WINDOW_DAYS} 天（按提测创建时间）；本周成功率 =
                本周已有结论的提测里成功的占比；等待构建 = 已投给 CRP、还没开始构建的包；
                项目配置数只算未删除的项目。数据截至 {formatTime(stats.generatedAt)}。
              </p>

              <table>
                <tbody>
                  <tr>
                    <td>
                      <strong>{stats.cards.weekReleaseCount}</strong>
                      <br />
                      本周提测次数
                      <br />
                      最近 {STATS_WINDOW_DAYS} 天
                    </td>
                    <td>
                      <strong>{stats.cards.waitingBuildCount}</strong>
                      <br />
                      等待构建数
                      <br />
                      已投 CRP、还没开始构建
                    </td>
                    <td>
                      <strong>
                        {stats.cards.weekSuccessRate.percent === null
                          ? "—"
                          : `${stats.cards.weekSuccessRate.percent}%`}
                      </strong>
                      <br />
                      本周成功率
                      <br />
                      {stats.cards.weekSuccessRate.settled === 0
                        ? "还没有已结论的提测"
                        : `${stats.cards.weekSuccessRate.success}/${stats.cards.weekSuccessRate.settled} 条已有结论`}
                    </td>
                    <td>
                      <strong>{stats.cards.projectCount}</strong>
                      <br />
                      项目配置数
                      <br />
                      未删除的项目
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={styles.section}>
              <h2 style={{ ...styles.title, fontSize: 16 }}>最近提测（前 5 条）</h2>
              {stats.recentReleases.length === 0 ? (
                <p style={styles.hint}>这个工作区还没有提测记录。</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>提测版本</th>
                      <th>状态</th>
                      <th>来源</th>
                      <th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentReleases.map((release) => (
                      <tr key={release.id}>
                        <td>{release.projectName}</td>
                        <td>
                          <Link href={`/releases/${release.id}`}>
                            <code>{release.version}</code>
                          </Link>
                        </td>
                        <td>{release.statusLabel}</td>
                        <td>{release.sourceLabel}</td>
                        <td>{formatTime(release.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={styles.section}>
              <h2 style={{ ...styles.title, fontSize: 16 }}>构建队列摘要（前 5 条）</h2>
              {stats.queueTasks.length === 0 ? (
                <p style={styles.hint}>
                  当前没有排队或构建中的包。<Link href="/queue">去构建队列</Link>
                </p>
              ) : (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>提测</th>
                        <th>软件包</th>
                        <th>阶段</th>
                        <th>进度</th>
                        <th>耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.queueTasks.map((task) => (
                        <tr key={task.snapshotId}>
                          <td>
                            {task.projectName} · <code>{task.releaseVersion}</code>
                          </td>
                          <td>
                            <code>{task.packageName}</code>
                          </td>
                          <td>{task.stage}</td>
                          <td>{task.progress ?? "—"}</td>
                          <td>{formatDuration(task.durationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={styles.hint}>
                    <Link href="/queue">去构建队列</Link>
                    ，看完整的依赖拓扑与调度事件流水。
                  </p>
                </>
              )}
            </div>

            <div style={styles.section}>
              <h2 style={{ ...styles.title, fontSize: 16 }}>项目提测概况</h2>
              {stats.projects.length === 0 ? (
                <p style={styles.hint}>这个工作区还没有项目。</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>本周提测</th>
                      <th>最近版本</th>
                      <th>最近状态</th>
                      <th>最近提测时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.projects.map((project) => (
                      <tr key={project.id}>
                        <td>
                          <Link href={`/projects/${project.id}`}>{project.name}</Link>
                        </td>
                        <td>{project.weekReleaseCount}</td>
                        <td>{project.latestVersion === null ? "还没有提测" : <code>{project.latestVersion}</code>}</td>
                        <td>{project.latestStatusLabel ?? "—"}</td>
                        <td>{formatTime(project.latestAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={styles.section}>
              <h2 style={{ ...styles.title, fontSize: 16 }}>配置待办</h2>
              <h3 style={{ ...styles.title, fontSize: 14 }}>未配软件清单的项目</h3>
              {stats.configTodo.missingSoftware.length === 0 ? (
                <p style={styles.hint}>所有项目都配了软件清单。</p>
              ) : (
                <ul style={styles.list}>
                  {stats.configTodo.missingSoftware.map((project) => (
                    <li key={project.id} style={styles.row}>
                      <Link href={`/projects/${project.id}`}>{project.name}</Link>
                      <code>{project.key}</code>
                      <span>清单为空，创建提测会被阻断</span>
                    </li>
                  ))}
                </ul>
              )}

              <h3 style={{ ...styles.title, fontSize: 14 }}>依赖有环的项目</h3>
              {stats.configTodo.dependencyCycles.length === 0 ? (
                <p style={styles.hint}>所有项目的软件清单都没有依赖环。</p>
              ) : (
                <ul style={styles.list}>
                  {stats.configTodo.dependencyCycles.map((project) => (
                    <li key={project.id} style={styles.row}>
                      <Link href={`/projects/${project.id}`}>{project.name}</Link>
                      <code>{project.key}</code>
                      <span>清单内依赖成环：{project.cycle}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

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
