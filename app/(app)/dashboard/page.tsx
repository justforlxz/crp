/**
 * 工作台：受保护页面，未登录会被 `requirePageAuth` 跳转到登录页。
 *
 * 页头就是页面名「工作台」。账号名、角色与退出登录在侧栏底部的账号区里（`components/page-shell.tsx`
 * 的 `AppNav`），不占页面标题。
 *
 * 页面本身不做角色判断，也不自己数数：统计卡、最近提测、队列摘要、项目概况、配置待办
 * 全部由 `lib/stats` 的 `loadDashboard` 一次读出来，数字都是数据库聚合查询的结果。
 * 切工作区后服务端组件重新取数，因此数字只反映当前工作区。
 *
 * 结构与 class 名来自 `.agents/spec/design/prototype.html` 的工作台（MKACG-964 的模块移植）：
 * `.stats` + `.stat` + `.stat-ico`、`.card panel` + `.panel-head`、`.queue-list` + `.queue-item`、
 * `.tip`、`.empty`。原型里有 `.progress`，但 `lib/stats` 只给「1/2 个架构完成」这样的文字、
 * 没有百分比，按「不改数据查询」的边界不自己造数字，进度文字放在 `.queue-info small` 里。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { requirePageAuth } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";
import { pickActiveWorkspace } from "@/lib/auth/workspaces";
import { formatDuration } from "@/lib/build";
import { releaseStatusPillClass } from "@/lib/releases";
import { loadDashboard, STATS_WINDOW_DAYS } from "@/lib/stats";
import { InviteMemberForm, WorkspaceSwitcher } from "./controls";

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
  // 会话还没记住工作区时（平台管理员刚注册就是这样）落到第一个可访问的，直接出统计；
  // 顶栏的工作区切换照旧，切一下就记住了。
  const active = pickActiveWorkspace(workspaces, { sessionWorkspaceId: auth.workspaceId });
  const stats = active === null ? null : await loadDashboard(active.id);

  return (
    <PageShell
      title="工作台"
      actions={
        <Link className="btn primary" href="/releases/new" data-style-anchor="dashboard.create-release">
          ＋ 创建提测
        </Link>
      }
    >
      <div className="card panel" data-style-anchor="dashboard.workspace-switcher">
        <div className="panel-head">
          <div>
            <h3>工作区</h3>
            <div className="sub">切换后统计与列表只反映当前工作区</div>
          </div>
        </div>
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
        <div className="card panel section-gap">
          <div className="empty" data-style-anchor="dashboard.empty">
            先选一个工作区，再看它的提测统计。
          </div>
        </div>
      ) : (
        <>
          <div className="grid stats section-gap" data-style-anchor="dashboard.stats">
            <div className="card stat">
              <div>
                <div className="label">本周提测次数</div>
                <div className="value">{stats.cards.weekReleaseCount}</div>
                <div className="hint">最近 {STATS_WINDOW_DAYS} 天创建的提测</div>
              </div>
              <div className="stat-ico si-blue" data-style-anchor="dashboard.stat-icon" aria-hidden="true">
                ⇧
              </div>
            </div>

            <div className="card stat">
              <div>
                <div className="label">等待构建</div>
                <div className="value">{stats.cards.waitingBuildCount}</div>
                <div className="hint">已投 CRP、还没开始构建的包</div>
              </div>
              <div className="stat-ico si-orange" data-style-anchor="dashboard.stat-icon" aria-hidden="true">
                ☷
              </div>
            </div>

            <div className="card stat">
              <div>
                <div className="label">本周成功率</div>
                <div className="value">
                  {stats.cards.weekSuccessRate.percent === null
                    ? "—"
                    : `${stats.cards.weekSuccessRate.percent}%`}
                </div>
                <div className="hint">
                  {stats.cards.weekSuccessRate.settled === 0
                    ? "还没有已结论的提测"
                    : `${stats.cards.weekSuccessRate.success}/${stats.cards.weekSuccessRate.settled} 条已有结论`}
                </div>
              </div>
              <div className="stat-ico si-green" data-style-anchor="dashboard.stat-icon" aria-hidden="true">
                ✓
              </div>
            </div>

            <div className="card stat">
              <div>
                <div className="label">项目配置数</div>
                <div className="value">{stats.cards.projectCount}</div>
                <div className="hint">未删除的项目</div>
              </div>
              <div className="stat-ico si-green" data-style-anchor="dashboard.stat-icon" aria-hidden="true">
                ▤
              </div>
            </div>
          </div>

          <div className="tip" data-style-anchor="dashboard.tip">
            <div className="tip-icon" aria-hidden="true">
              ⓘ
            </div>
            <div>
              <b>统计口径</b>
              <p>
                本周 = 最近 {STATS_WINDOW_DAYS} 天（按提测创建时间）；本周成功率 = 本周已有结论的提测里
                成功的占比；等待构建 = 已投给 CRP、还没开始构建的包；项目配置数只算未删除的项目。数据截至{" "}
                {formatTime(stats.generatedAt)}。
              </p>
            </div>
          </div>

          <div className="grid two-col section-gap">
            <div className="card panel" data-style-anchor="dashboard.recent-releases">
              <div className="panel-head">
                <div>
                  <h3>最近提测</h3>
                  <div className="sub">按创建时间排序，前 5 条</div>
                </div>
                <Link className="text-link" href="/releases">
                  查看全部 →
                </Link>
              </div>
              {stats.recentReleases.length === 0 ? (
                <div className="empty" data-style-anchor="dashboard.empty">
                  这个工作区还没有提测记录。
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table" data-style-anchor="dashboard.recent-releases-table">
                    <thead>
                      <tr>
                        <th>提测记录 / 项目</th>
                        <th>版本号</th>
                        <th>状态</th>
                        <th>创建时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentReleases.map((release) => (
                        <tr key={release.id}>
                          <td>
                            <div className="primary-cell">
                              <Link href={`/releases/${release.id}`}>{release.projectName}</Link>
                            </div>
                            <div className="secondary">{release.sourceLabel}</div>
                          </td>
                          <td className="mono">{release.version}</td>
                          <td>
                            <span className={releaseStatusPillClass(release.status)}>
                              {release.statusLabel}
                            </span>
                          </td>
                          <td>{formatTime(release.createdAt)}</td>
                          <td>
                            <Link className="btn sm" href={`/releases/${release.id}`}>
                              详情
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card panel" data-style-anchor="dashboard.queue-summary">
              <div className="panel-head">
                <div>
                  <h3>构建队列</h3>
                  <div className="sub">项目清单内的软件按依赖排序，前 5 条</div>
                </div>
                <Link className="text-link" href="/queue">
                  队列详情 →
                </Link>
              </div>
              {stats.queueTasks.length === 0 ? (
                <div className="empty" data-style-anchor="dashboard.empty">
                  当前没有排队或构建中的包。
                </div>
              ) : (
                <div className="queue-list" data-style-anchor="dashboard.queue-list">
                  {stats.queueTasks.map((task) => (
                    <div className="queue-item" key={task.snapshotId} data-style-anchor="dashboard.queue-item">
                      <div className="queue-icon" aria-hidden="true">
                        ▣
                      </div>
                      <div className="queue-info">
                        <b>{task.packageName}</b>
                        <small>
                          {task.projectName} · {task.releaseVersion}
                          {task.progress === null ? null : ` · ${task.progress}`}
                        </small>
                      </div>
                      <div className="queue-meta">
                        <b>{task.stage}</b>
                        <small>{formatDuration(task.durationMs)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="tip">
                <div className="tip-icon" aria-hidden="true">
                  ✦
                </div>
                <div>
                  <b>依赖只用于构建排序</b>
                  <p>
                    项目清单中的全部软件都会参与本次提测；依赖关系来自软件包记录，清单内依赖按拓扑顺序
                    提交，清单外依赖不自动加入。
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid two-col section-gap">
            <div className="card panel" data-style-anchor="dashboard.project-overview">
              <div className="panel-head">
                <div>
                  <h3>项目提测概况</h3>
                  <div className="sub">当前工作区 · 最近 {STATS_WINDOW_DAYS} 天</div>
                </div>
                <Link className="text-link" href="/projects">
                  项目配置 →
                </Link>
              </div>
              {stats.projects.length === 0 ? (
                <div className="empty" data-style-anchor="dashboard.empty">
                  这个工作区还没有项目。
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
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
                            <div className="primary-cell">
                              <Link href={`/projects/${project.id}`}>{project.name}</Link>
                            </div>
                          </td>
                          <td>{project.weekReleaseCount}</td>
                          <td className="mono">
                            {project.latestVersion === null ? "—" : project.latestVersion}
                          </td>
                          <td>
                            {project.latestStatus === null || project.latestStatusLabel === null ? (
                              "—"
                            ) : (
                              <span className={releaseStatusPillClass(project.latestStatus)}>
                                {project.latestStatusLabel}
                              </span>
                            )}
                          </td>
                          <td>{formatTime(project.latestAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card panel" data-style-anchor="dashboard.config-todo">
              <div className="panel-head">
                <div>
                  <h3>项目配置概况</h3>
                  <div className="sub">需要关注的项目配置</div>
                </div>
                <span className="tag">
                  {stats.configTodo.missingSoftware.length + stats.configTodo.dependencyCycles.length}{" "}
                  个待配置
                </span>
              </div>
              {stats.configTodo.missingSoftware.length === 0 &&
              stats.configTodo.dependencyCycles.length === 0 ? (
                <div className="empty" data-style-anchor="dashboard.empty">
                  所有项目都已配置软件清单，也没有依赖环。
                </div>
              ) : (
                <div className="queue-list" data-style-anchor="dashboard.config-list">
                  {stats.configTodo.missingSoftware.map((project) => (
                    <div className="queue-item" key={`missing-${project.id}`}>
                      <div className="queue-icon" aria-hidden="true">
                        ▤
                      </div>
                      <div className="queue-info">
                        <b>{project.name}</b>
                        <small>
                          尚未配置软件包清单（{project.key}），创建提测会被阻断
                        </small>
                      </div>
                      <Link className="btn sm" href={`/projects/${project.id}`}>
                        配置项目
                      </Link>
                    </div>
                  ))}
                  {stats.configTodo.dependencyCycles.map((project) => (
                    <div className="queue-item" key={`cycle-${project.id}`}>
                      <div className="queue-icon" aria-hidden="true">
                        ↺
                      </div>
                      <div className="queue-info">
                        <b>{project.name}</b>
                        <small>清单内依赖成环：{project.cycle}</small>
                      </div>
                      <Link className="btn sm" href={`/projects/${project.id}`}>
                        配置项目
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {auth.account.isPlatformAdmin ? (
            <div className="card panel section-gap" data-style-anchor="dashboard.invite-form">
              <div className="panel-head">
                <div>
                  <h3>邀请成员到「{active?.name}」</h3>
                  <div className="sub">
                    邮箱已有账号时只补成员关系，不改原密码；没有账号时按填写的初始密码建号。
                  </div>
                </div>
              </div>
              <InviteMemberForm workspaceId={active?.id ?? ""} />
            </div>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
