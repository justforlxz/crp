/**
 * 工作台：受保护页面，未登录会被 `requirePageAuth` 跳转到登录页。
 *
 * 结构与类名照 `.agents/spec/design/prototype.html` 的工作台：
 *
 * ```
 * .stats (4 × .stat，含 .stat-ico)
 * .panel  最近的提测（.table-scroll + table.grid）
 * .panel  构建队列（.queue-list）
 * .tip
 * .panel  项目概况（.table-scroll + table.grid）
 * ```
 *
 * 页面标题在顶栏（`PageShell` 的 `.topbar`），内容区不再放 `<h1>`。
 *
 * 数字全部由 `lib/stats` 的 `loadDashboard` 一次读出来，页面不自己数行：四张卡按提测状态计，
 * 项目概况的经理、软件包数、依赖数与最近一次提测都来自同一次查询。
 *
 * 原型之外多两块：**配置待办**（哪些项目现在提不了测）与**邀请成员**（仅平台管理员）。
 * 这两块是既有的实际功能，原型没有画；用同一套 `.panel` 容器收在页面最下面，不打乱上面五块的顺序。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { Icon, type IconName } from "@/components/icons";
import { JobQueueItem } from "@/components/job-detail";
import { PageShell } from "@/components/page-shell";
import { requirePageAuth } from "@/lib/auth/server";
import { listWorkspacesForAccount } from "@/lib/auth/store";
import { pickActiveWorkspace } from "@/lib/auth/workspaces";
import { formatDuration } from "@/lib/build";
import { loadDashboard, type DashboardCards } from "@/lib/stats";
import { showsWorkspaceSwitcher } from "../workspaceScope";
import { InviteMemberForm, WorkspaceSwitcher } from "./controls";

export const metadata: Metadata = { title: "工作台 · CRP 提测平台" };

// 统计数字每次进页面都要现算，不做静态化。
export const dynamic = "force-dynamic";

/** 与构建队列页同一套时间口径：一律按 UTC 展示。 */
function formatTime(value: Date | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** 一张统计卡。四张卡的结构一致：文字块 + 图标块（`.stat-main` + `.stat-ico`）。 */
function Stat({
  label,
  value,
  foot,
  icon,
  tone,
}: {
  label: string;
  value: number;
  foot: string;
  icon: IconName;
  tone: string;
}) {
  return (
    <div className="stat">
      <div className="stat-main">
        <div className="stat-label">{label}</div>
        <div className="stat-value num">{value}</div>
        <div className="stat-foot">{foot}</div>
      </div>
      <div className={`stat-ico is-${tone}`} data-style-anchor="dashboard.stat-icon" aria-hidden="true">
        <Icon name={icon} />
      </div>
    </div>
  );
}

/** 四张卡的口径与顺序照原型：进行中 → 成功 → 失败 → 待投递。 */
function statsOf(cards: DashboardCards): Array<{
  label: string;
  value: number;
  foot: string;
  icon: IconName;
  tone: string;
}> {
  return [
    {
      label: "进行中的提测",
      value: cards.inProgressReleases,
      foot: "投递中与构建中",
      icon: "releases",
      tone: "accent",
    },
    {
      label: "构建成功",
      value: cards.succeededReleases,
      foot: "全部已成功的提测",
      icon: "check",
      tone: "ok",
    },
    {
      label: "构建失败",
      value: cards.failedReleases,
      foot: "含部分失败，需要重试",
      icon: "alert",
      tone: "bad",
    },
    {
      label: "等待投递",
      value: cards.waitingReleases,
      foot: "已创建、尚未投递",
      icon: "clock",
      tone: "warn",
    },
  ];
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

  const todoCount =
    stats === null
      ? 0
      : stats.configTodo.missingSoftware.length + stats.configTodo.dependencyCycles.length;

  return (
    <PageShell
      title="工作台"
      description="今天要处理的事"
      actions={
        <Link
          className="btn btn-primary"
          href="/releases/new"
          data-style-anchor="dashboard.create-release"
        >
          <Icon name="plus" />
          创建提测
        </Link>
      }
    >
      {active === null || stats === null ? (
        <div className="panel" data-style-anchor="dashboard.empty">
          <div className="panel-bd">
            <div className="empty">
              <div className="empty-ico" aria-hidden="true">
                <Icon name="empty" />
              </div>
              <div className="empty-t">先选一个工作区</div>
              <div className="empty-d">工作区的统计、最近提测与项目概况都按工作区隔离。</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="stack">
          {showsWorkspaceSwitcher(workspaces) ? (
            <div className="filters" data-style-anchor="dashboard.workspace-bar">
              <WorkspaceSwitcher
                workspaces={workspaces.map((workspace) => ({
                  id: workspace.id,
                  name: workspace.name,
                  role: workspace.role,
                }))}
                activeId={active.id}
              />
            </div>
          ) : null}

          <div className="stats" data-style-anchor="dashboard.stats">
            {statsOf(stats.cards).map((card) => (
              <Stat key={card.label} {...card} />
            ))}
          </div>

          <div className="panel" data-style-anchor="dashboard.recent-releases">
            <div className="panel-hd">
              <h2>最近的提测</h2>
              <span className="hint">按创建时间倒序</span>
              <div className="spacer" />
              <Link className="btn btn-quiet btn-sm" href="/releases">
                查看全部
              </Link>
            </div>
            <div className="panel-bd flush table-scroll">
              <table className="grid cols-recent" data-style-anchor="dashboard.recent-releases-table">
                <thead>
                  <tr>
                    <th>提测记录</th>
                    <th>所属项目</th>
                    <th className="num">软件包</th>
                    <th>状态</th>
                    <th className="num">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentReleases.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty" data-style-anchor="dashboard.empty">
                          <div className="empty-ico" aria-hidden="true">
                            <Icon name="empty" />
                          </div>
                          <div className="empty-t">这个工作区还没有提测</div>
                          <div className="empty-d">创建一次提测，它就会出现在这里。</div>
                          <Link className="btn btn-sm" href="/releases/new">
                            创建提测
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    stats.recentReleases.map((release) => (
                      <tr key={release.id} className="is-clickable">
                        <td>
                          <Link href={`/releases/${release.id}`}>
                            <strong>{release.version}</strong>
                          </Link>
                          <span className="cell-sub">{release.sourceLabel}</span>
                        </td>
                        <td>{release.projectName}</td>
                        <td className="num">{release.packageCount} 个</td>
                        <td>
                          <span className={`dot ${release.statusTone}`}>{release.statusLabel}</span>
                        </td>
                        <td className="num">{formatTime(release.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" data-style-anchor="dashboard.queue-summary">
            <div className="panel-hd">
              <h2>构建队列</h2>
              <span className="hint">依赖满足后自动投递</span>
              <div className="spacer" />
              <Link className="btn btn-quiet btn-sm" href="/queue">
                打开队列
              </Link>
            </div>
            {stats.queueTasks.length === 0 ? (
              <div className="empty" data-style-anchor="dashboard.queue-empty">
                <div className="empty-ico" aria-hidden="true">
                  <Icon name="empty" />
                </div>
                <div className="empty-t">当前没有排队或构建中的包</div>
                <div className="empty-d">投递之后，上游包先构建，成功后才轮到下游。</div>
              </div>
            ) : (
              <div className="queue-list" data-style-anchor="dashboard.queue-list">
                {stats.queueTasks.map((task) => (
                  <JobQueueItem
                    job={task}
                    key={task.snapshotId}
                    className="queue-item is-clickable"
                  >
                    <div className="qi-ico" aria-hidden="true">
                      <Icon name="box" />
                    </div>
                    <div className="queue-info">
                      <div className="qi-name">
                        <b>{task.packageName}</b>
                        <small className="num">{task.releaseVersion}</small>
                      </div>
                      <div className="qi-desc">{task.progress ?? task.projectName}</div>
                      {task.progressPercent === null ? null : (
                        <div className="qi-bar">
                          <progress
                            value={task.progressPercent}
                            max={100}
                            aria-label={`${task.packageName} 构建进度`}
                          />
                          <span className="qi-pct num">{task.progressPercent}%</span>
                        </div>
                      )}
                    </div>
                    <div className="qi-meta">
                      <b>{task.stage}</b>
                      {formatDuration(task.durationMs)}
                    </div>
                  </JobQueueItem>
                ))}
              </div>
            )}
          </div>

          <div className="tip" data-style-anchor="dashboard.tip">
            <Icon name="info" />
            <div>
              <b>投递是串行的。</b>同一个提测里，上游软件包构建成功之后才会投递下游。上游失败时，
              下游保持「等待上游」，不会自动重试。项目清单里的全部软件都会提测；依赖只决定顺序，
              不决定谁进清单。
            </div>
          </div>

          <div className="panel" data-style-anchor="dashboard.project-overview">
            <div className="panel-hd">
              <h2>项目概况</h2>
              <div className="spacer" />
              <Link className="btn btn-quiet btn-sm" href="/projects">
                管理项目
              </Link>
            </div>
            <div className="panel-bd flush table-scroll">
              <table className="grid cols-projects">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>项目经理</th>
                    <th className="num">软件包</th>
                    <th className="num">依赖</th>
                    <th>最近提测</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.projects.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty" data-style-anchor="dashboard.projects-empty">
                          <div className="empty-ico" aria-hidden="true">
                            <Icon name="empty" />
                          </div>
                          <div className="empty-t">这个工作区还没有项目</div>
                          <div className="empty-d">提测要挂在项目上，先去项目页建一个。</div>
                          <Link className="btn btn-sm" href="/projects/new">
                            新建项目
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    stats.projects.map((project) => (
                      <tr key={project.id}>
                        <td>
                          <Link href={`/projects/${project.id}`}>
                            <strong>{project.name}</strong>
                          </Link>
                          <span className="cell-sub col-mono">{project.key}</span>
                        </td>
                        <td>{project.managerName}</td>
                        <td className="num">{project.packageCount}</td>
                        <td className="num">{project.dependencyCount}</td>
                        <td>
                          {project.latestStatusLabel === null ? (
                            <span className="muted">还没有提测</span>
                          ) : (
                            <>
                              <span className={`dot ${project.latestStatusTone ?? "is-wait"}`}>
                                {project.latestStatusLabel}
                              </span>
                              <span className="cell-sub">{formatTime(project.latestAt)}</span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" data-style-anchor="dashboard.config-todo">
            <div className="panel-hd">
              <h2>配置待办</h2>
              <span className="hint">这些项目现在提不了测</span>
              <div className="spacer" />
              <span className="chip">
                <i>{todoCount}</i> 个待配置
              </span>
            </div>
            {todoCount === 0 ? (
              <div className="panel-bd">
                <p className="hint">所有项目都已配置软件清单，也没有依赖环。</p>
              </div>
            ) : (
              <div className="queue-list" data-style-anchor="dashboard.config-list">
                {stats.configTodo.missingSoftware.map((project) => (
                  <div className="queue-item" key={`missing-${project.id}`}>
                    <div className="qi-ico" aria-hidden="true">
                      <Icon name="projects" />
                    </div>
                    <div className="queue-info">
                      <div className="qi-name">
                        <b>{project.name}</b>
                        <small className="num">{project.key}</small>
                      </div>
                      <div className="qi-desc">还没有配置软件包清单，创建提测会被阻断。</div>
                    </div>
                    <Link className="btn btn-sm" href={`/projects/${project.id}`}>
                      配置项目
                    </Link>
                  </div>
                ))}
                {stats.configTodo.dependencyCycles.map((project) => (
                  <div className="queue-item" key={`cycle-${project.id}`}>
                    <div className="qi-ico" aria-hidden="true">
                      <Icon name="baselines" />
                    </div>
                    <div className="queue-info">
                      <div className="qi-name">
                        <b>{project.name}</b>
                        <small className="num">{project.key}</small>
                      </div>
                      <div className="qi-desc">清单内依赖成环：{project.cycle}</div>
                    </div>
                    <Link className="btn btn-sm" href={`/projects/${project.id}`}>
                      配置项目
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>

          {auth.account.isPlatformAdmin ? (
            <div className="panel" data-style-anchor="dashboard.invite-form">
              <div className="panel-hd">
                <h2>邀请成员到「{active?.name}」</h2>
                <span className="hint">邮箱已有账号时只补成员关系，不改原密码</span>
              </div>
              <div className="panel-bd">
                <InviteMemberForm workspaceId={active.id} />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
