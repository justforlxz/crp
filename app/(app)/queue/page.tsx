/**
 * 构建队列页：谁在等谁、卡在哪个上游、这一轮调度做了什么。
 *
 * 只读页面：数据全部由服务端的定时轮询写进库里，页面不自己调 CRP / Shuttle，
 * 也不用前端轮询去驱动状态写入（MUST NOT）。「立即轮询」按钮调
 * `app/(app)/queue/actions.ts` 里的服务端动作，与定时入口共用同一个 `runBuildPoll()`。
 *
 * 四张统计卡的数字与下面的任务表出自同一次查询，不会出现「卡上 3 个、表里 5 个」。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
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
 * 投递失败在「原因」列里的样子。
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
 * 「原因」列：构建任务的失败原因优先；还没有构建任务时看这个包最近一次投递失败。
 *
 * 限流与网络失败各自带一个彩色徽标，扫一眼就能分清「等一等」和「去查链路」。
 */
function reasonCell(task: QueueTaskRow) {
  if (task.reason !== null) {
    return task.reason;
  }

  if (task.dispatchFailure === null) {
    return "—";
  }

  const style = DISPATCH_FAILURE_STYLE[task.dispatchFailure.kind];

  return (
    <>
      <span className={style.badge}>{style.title}</span> {style.detail}
    </>
  );
}

/** 任务列表的一行。提测列带上项目名，跨项目看也不会混。 */
function taskRow(release: QueueReleaseView, task: QueueTaskRow) {
  return (
    <tr key={task.snapshotId}>
      <td>
        {release.projectName} · <code>{release.version}</code>
      </td>
      <td>
        <code>{task.packageName}</code>
      </td>
      <td>{task.stage}</td>
      <td>{task.progress ?? "—"}</td>
      <td>{formatDuration(task.durationMs)}</td>
      <td>{task.waitingFor.length === 0 ? "—" : task.waitingFor.join("、")}</td>
      <td>{reasonCell(task)}</td>
    </tr>
  );
}

function eventRow(event: BuildPollEventRow) {
  return (
    <tr key={event.id}>
      <td>{formatTime(event.createdAt)}</td>
      <td>
        {event.releaseVersion === null ? "—" : <code>{event.releaseVersion}</code>}
      </td>
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

  return (
    <PageShell title="构建队列">
      <p data-style-anchor="queue.intro">
        这里回答三个问题：哪些包还在排队、各自卡在哪个上游、这一轮调度做了什么。
        提测按创建时间从新到旧列出，刚投递的排在最前。页面只读库里的状态，状态由服务端定时轮询写入；
        「立即轮询」会真的去问一次 CRP 与 Shuttle。
      </p>

      {query.error === undefined ? null : (
        <p className="alert alert--error" role="alert">
          操作失败：{query.error}
        </p>
      )}
      {query.notice === undefined ? null : (
        <p className="alert alert--info" role="status">
          {query.notice}
        </p>
      )}

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

      <h2>概览</h2>
      <div className="stat-grid" data-style-anchor="queue.stats">
        <div className="stat-card">
          <strong>{view.stats.queued}</strong>
          队列任务数
          <br />
          <small>还没到终态的包</small>
        </div>
        <div className="stat-card">
          <strong>{view.stats.building}</strong>
          构建中
          <br />
          <small>含投递中</small>
        </div>
        <div className="stat-card">
          <strong>{view.stats.waiting}</strong>
          等待依赖
          <br />
          <small>卡在上游没成功</small>
        </div>
        <div className="stat-card">
          <strong>{view.stats.finishedToday}</strong>
          今日完成
          <br />
          <small>今天（UTC）拿到终态的构建</small>
        </div>
      </div>
      <p>数据截至：{formatTime(view.generatedAt)}</p>

      <form action={refreshQueueAction.bind(null, scope.active.slug)} data-style-anchor="queue.refresh">
        <button type="submit" className="btn btn-primary">
          立即轮询
        </button>
      </form>
      <p>
        手动轮询与定时轮询走同一段代码：回写 Shuttle 的构建结果、CRP 的工作流进度，
        并把这一轮做的事记进调度事件流水。轮询失败不会把构建状态改成失败，只记一条同步错误。
      </p>

      <h2 data-style-anchor="queue.topo">依赖拓扑</h2>
      {view.releases.length === 0 ? (
        <p>当前没有未完结的提测。已完结的提测不再轮询，也不再占队列。</p>
      ) : (
        view.releases.map((release) => (
          <section key={release.releaseId}>
            <h3>
              {release.projectName} · <code>{release.version}</code>（{release.statusLabel}）
            </h3>
            <p>
              CRP 工作流进度：
              {release.workProgress === null
                ? "还没同步到"
                : `${release.workProgress} ${release.workProgressLabel ?? ""}`}
              （最近同步：{formatTime(release.workProgressSyncedAt)}）
            </p>
            {release.tasks.length === 0 ? (
              <p className="empty">这条提测还没有软件包。</p>
            ) : (
              <ul>
                {release.tasks.map((task) => {
                  const upstreams = upstreamsOf(release, task.packageName);

                  return (
                    <li key={task.snapshotId}>
                      <code>{task.packageName}</code>（{task.stage}）
                      {upstreams.length === 0
                        ? "　无上游依赖"
                        : `　依赖上游：${upstreams.join("、")}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))
      )}

      <h2>任务列表</h2>
      {view.releases.length === 0 ? (
        <p className="empty">没有要展示的任务。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-style-anchor="queue.task-table">
            <thead>
              <tr>
                <th>提测</th>
                <th>软件包</th>
                <th>阶段</th>
                <th>进度</th>
                <th>耗时</th>
                <th>等待的上游</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {view.releases.flatMap((release) =>
                release.tasks.map((task) => taskRow(release, task)),
              )}
            </tbody>
          </table>
        </div>
      )}

      <h2>调度事件流水（最近 30 条）</h2>
      {view.events.length === 0 ? (
        <p className="empty">还没有调度记录。定时轮询跑过一轮之后，这里会记下每一轮做了什么。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-style-anchor="queue.event-table">
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
    </PageShell>
  );
}
