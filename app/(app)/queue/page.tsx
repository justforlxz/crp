/**
 * 构建队列页：谁在等谁、卡在哪个上游、这一轮调度做了什么。
 *
 * 只读页面：数据全部由服务端的定时轮询写进库里，页面不自己调 CRP / Shuttle，
 * 也不用前端轮询去驱动状态写入（MUST NOT）。「立即轮询」按钮调
 * `app/(app)/queue/actions.ts` 里的服务端动作，与定时入口共用同一个 `runBuildPoll()`。
 *
 * 四张统计卡的数字与下面的任务列表出自同一次查询，不会出现「卡上 3 个、列表里 5 个」。
 *
 * 结构与 class 名来自 `.agents/spec/design/prototype.html` 的构建队列页（MKACG-972 的模块移植）：
 * `.stats` + `.stat` + `.stat-ico`、`.dep-flow` + `.dep-row`、`.queue-list` + `.queue-item`、
 * `.tip`，操作反馈走全局 `.toast`。依赖顺序取 `lib/build/queue.ts` 里 `sortByDependencies`
 * 算出的拓扑序，与投递层同一份实现；进度条用真实比例（已完成架构 / 全部架构），
 * 不照抄原型里硬编码的 68%。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { formatDuration, loadBuildQueue } from "@/lib/build";
import type {
  BuildPollEventRow,
  DispatchFailureKind,
  QueueReleaseView,
  QueueTaskRow,
} from "@/lib/build";

import { resolveWorkspaceScope } from "../workspaceScope";
import { refreshQueueAction } from "./actions";

export const metadata: Metadata = { title: "构建队列 · CRP 提测平台" };

// 数据每次轮询都在变，页面不做静态化。
export const dynamic = "force-dynamic";

type QueuePageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

/** 事件类型的中文名，与 `lib/build/pollEvent.ts` 里的六种事件对应。 */
const EVENT_LABELS: Record<string, string> = {
  poll: "轮询",
  status: "状态变化",
  progress: "进度同步",
  dispatch_rate_limited: "投递限流",
  dispatch_network_failed: "投递网络失败",
  dispatch_failed: "投递失败",
};

/**
 * 投递失败在「原因」里的样子。
 *
 * 限流要等、网络失败要查链路，两者不能共用一句「失败」，否则运维会去查一条其实好好的链路，
 * 或者在限流窗口里反复重投。颜色也不同：限流是提醒，网络失败是错误。
 */
const DISPATCH_FAILURE_STYLE: Record<
  DispatchFailureKind,
  { badge: string; title: string; detail: string }
> = {
  rate_limited: {
    badge: "badge badge--warn",
    title: "限流等待",
    detail: "CRP 限流，等窗口过去再投",
  },
  network: {
    badge: "badge badge--danger",
    title: "网络失败",
    detail: "连不上 CRP，等下一轮再投",
  },
  failed: {
    badge: "badge",
    title: "投递失败",
    detail: "CRP 没有收下这次投递，原因见调度事件流水",
  },
};

function formatTime(value: Date | null): string {
  if (!value) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

/** 一个包的完整上游名单：拓扑视图要的是全部上游，不只是还没成功的那些。 */
function upstreamsOf(release: QueueReleaseView, packageName: string): string[] {
  return release.edges.filter((edge) => edge.to === packageName).map((edge) => edge.from);
}

/**
 * 「原因」：构建任务的失败原因优先；还没有构建任务时看这个包最近一次投递失败。
 *
 * 限流与网络失败各自带一个彩色徽标，扫一眼就能分清「等一等」和「去查链路」。
 */
function reasonCell(task: QueueTaskRow) {
  if (task.reason !== null) {
    return task.reason;
  }

  if (task.dispatchFailure === null) {
    return null;
  }

  const style = DISPATCH_FAILURE_STYLE[task.dispatchFailure.kind];

  return (
    <>
      <span className={style.badge}>{style.title}</span> {style.detail}
    </>
  );
}

/** 依赖拓扑里的一行：序号、软件包、上游说明、当前状态。 */
function depRow(release: QueueReleaseView, task: QueueTaskRow, index: number) {
  const upstreams = upstreamsOf(release, task.packageName);

  return (
    <div className="dep-row row" key={task.snapshotId}>
      <span className="tag" aria-hidden="true">
        {index + 1}
      </span>
      <b>{task.packageName}</b>
      <span className="hint">
        {upstreams.length === 0 ? "无上游依赖" : `依赖 ${upstreams.join("、")}`}
      </span>
      <span className="small-note">
        {task.stage}
        {task.progress === null ? null : ` · ${task.progress}`}
      </span>
    </div>
  );
}

/** 队列任务列表里的一行：图标、软件包与说明、进度条、耗时与依赖。 */
function queueItem(release: QueueReleaseView, task: QueueTaskRow, index: number) {
  const reason = reasonCell(task);

  return (
    <div className="queue-item" key={task.snapshotId}>
      <div className="queue-icon" aria-hidden="true">
        {index + 1}
      </div>
      <div className="queue-info">
        <b>{task.packageName}</b>
        <small>
          {release.projectName} · <code>{release.version}</code> · {task.stage}
        </small>
        {reason === null ? null : <small>{reason}</small>}
        {task.progressPercent === null ? null : (
          <progress
            className="progress"
            value={task.progressPercent}
            max={100}
            aria-label={`${task.packageName} 构建进度`}
          />
        )}
      </div>
      <div className="queue-meta">
        <b>{task.progress ?? "—"}</b>
        <small>{formatDuration(task.durationMs)}</small>
      </div>
    </div>
  );
}

function eventRow(event: BuildPollEventRow) {
  return (
    <tr key={event.id}>
      <td>{formatTime(event.createdAt)}</td>
      <td>{event.releaseVersion === null ? "—" : <code>{event.releaseVersion}</code>}</td>
      <td>{event.packageName === null ? "—" : <code>{event.packageName}</code>}</td>
      <td>{eventLabel(event.event)}</td>
      <td>{event.condition}</td>
      <td>{event.result}</td>
    </tr>
  );
}

export default async function QueuePage({ searchParams }: QueuePageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/queue", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="构建队列">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const view = await loadBuildQueue(scope.active.id);
  const tasks = view.releases.flatMap((release) =>
    release.tasks.map((task) => ({ release, task })),
  );

  return (
    <PageShell
      title="构建队列"
      actions={
        <form
          action={refreshQueueAction.bind(null, scope.active.slug)}
          data-style-anchor="queue.refresh"
        >
          <button type="submit" className="btn btn-primary">
            立即轮询
          </button>
        </form>
      }
    >
      <p className="hint" data-style-anchor="queue.intro">
        这里回答三个问题：哪些包还在排队、各自卡在哪个上游、这一轮调度做了什么。
        提测按创建时间从新到旧列出，刚投递的排在最前。页面只读库里的状态，状态由服务端定时轮询写入；
        「立即轮询」会真的去问一次 CRP 与 Shuttle。
      </p>

      <Toast
        className="toast alert alert--error"
        role="alert"
        message={query.error === undefined ? null : `操作失败：${query.error}`}
      />
      <Toast
        className="toast alert alert--info"
        message={query.notice === undefined ? null : query.notice}
      />

      <p className="row" data-style-anchor="queue.workspace-switcher">
        工作区：
        {scope.workspaces.map((workspace) => (
          <span key={workspace.id}>
            <Link href={`/queue?workspace=${encodeURIComponent(workspace.slug)}`}>
              {workspace.name}
            </Link>
            {workspace.id === scope.active?.id ? "（当前）" : null}{" "}
          </span>
        ))}
      </p>

      <div className="grid stats" data-style-anchor="queue.stats">
        <div className="card stat">
          <div>
            <div className="label">队列任务</div>
            <div className="value">{view.stats.queued}</div>
            <div className="hint">还没到终态的包</div>
          </div>
          <div className="stat-ico si-blue" aria-hidden="true">
            ☷
          </div>
        </div>

        <div className="card stat">
          <div>
            <div className="label">正在构建</div>
            <div className="value">{view.stats.building}</div>
            <div className="hint">含投递中</div>
          </div>
          <div className="stat-ico si-orange" aria-hidden="true">
            ◌
          </div>
        </div>

        <div className="card stat">
          <div>
            <div className="label">等待依赖</div>
            <div className="value">{view.stats.waiting}</div>
            <div className="hint">卡在上游没成功</div>
          </div>
          <div className="stat-ico si-blue" aria-hidden="true">
            ↳
          </div>
        </div>

        <div className="card stat">
          <div>
            <div className="label">今日已完成</div>
            <div className="value">{view.stats.finishedToday}</div>
            <div className="hint">今天（UTC）拿到终态的构建</div>
          </div>
          <div className="stat-ico si-green" aria-hidden="true">
            ✓
          </div>
        </div>
      </div>

      <div className="grid two-col section-gap">
        <div className="card panel" data-style-anchor="queue.topo">
          <div className="panel-head">
            <div>
              <h3>当前任务依赖拓扑</h3>
              <div className="sub">上游在前的投递顺序 · 数据截至 {formatTime(view.generatedAt)}</div>
            </div>
            <span className="pill p-blue">自动编排中</span>
          </div>

          {view.releases.length === 0 ? (
            <div className="empty">当前没有未完结的提测。已完结的提测不再轮询，也不再占队列。</div>
          ) : (
            view.releases.map((release) => {
              const byName = new Map(release.tasks.map((task) => [task.packageName, task]));

              return (
                <section key={release.releaseId}>
                  <div className="section-title">
                    <b>
                      {release.projectName} · <code>{release.version}</code>
                    </b>
                    <small>{release.statusLabel}</small>
                  </div>
                  {release.tasks.length === 0 ? (
                    <div className="empty">这条提测还没有软件包。</div>
                  ) : (
                    <div className="dep-flow">
                      {release.order.map((name, index) => {
                        const task = byName.get(name);

                        return task === undefined ? null : depRow(release, task, index);
                      })}
                    </div>
                  )}
                </section>
              );
            })
          )}

          <div className="tip">
            <div className="tip-icon" aria-hidden="true">
              ✦
            </div>
            <div>
              <b>调度规则</b>
              <p>
                本次提测包含项目清单中的全部软件。清单内的依赖均按软件包记录配置的顺序提交，并等待上游完成；
                清单外的依赖使用目标 CRP 仓库中已有版本，不会扩展本次提测清单。失败时会阻断下游任务并通知提测创建人。
              </p>
            </div>
          </div>
        </div>

        <div className="card panel">
          <div className="panel-head">
            <div>
              <h3>队列任务列表</h3>
              <div className="sub">按实际可执行顺序排列</div>
            </div>
            <span className="small-note">最后更新 {formatTime(view.generatedAt)}</span>
          </div>

          {tasks.length === 0 ? (
            <div className="empty">没有要展示的任务。</div>
          ) : (
            <div className="queue-list" data-style-anchor="queue.task-list">
              {tasks.map(({ release, task }, index) => queueItem(release, task, index))}
            </div>
          )}
        </div>
      </div>

      <div className="card panel section-gap">
        <div className="panel-head">
          <div>
            <h3>自动排队记录</h3>
            <div className="sub">
              平台生成的调度事件 · 最近 30 条 · 手动轮询与定时轮询走同一段代码
            </div>
          </div>
        </div>

        {view.events.length === 0 ? (
          <div className="empty">
            还没有调度记录。定时轮询跑过一轮之后，这里会记下每一轮做了什么。
          </div>
        ) : (
          <div className="table-scroll" data-style-anchor="queue.event-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>提测</th>
                  <th>软件包</th>
                  <th>事件</th>
                  <th>触发条件</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>{view.events.map((event) => eventRow(event))}</tbody>
            </table>
          </div>
        )}
      </div>

    </PageShell>
  );
}
