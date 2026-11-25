/**
 * 构建队列页的正文块（MKACG-987）：四张统计卡、依赖与投递顺序、构建作业、限流提示、调度事件。
 *
 * 结构照 `.agents/spec/design/prototype.html` 的 `<section data-page="queue">`：
 * `.stack` 里依次是 `.stats` → 依赖 `.panel` → 作业 `.panel` → `.tip` → 调度事件 `.panel`。
 * 类名与 DOM 层级照原型，数据全是真的（原型里的 68%、2 个进行中都是演示值，这里不照抄）。
 *
 * 为什么单独一个文件：页面要连库、要读会话，这里只拿视图数据画界面。拆开之后
 * `tests/queue-board.test.ts` 能直接把它渲染成 HTML，数模块个数、看结构有没有降级。
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { formatDuration } from "@/lib/build";
import type {
  BuildPollEventRow,
  BuildQueueStats,
  BuildQueueView,
  DispatchFailureKind,
  QueueReleaseView,
  QueueTaskRow,
  StagePhase,
} from "@/lib/build";

/**
 * 原型 `<symbol>` 里的图标，路径原样搬过来。尺寸由样式表给
 * （`.stat-ico svg` 18px、`.qi-ico svg` 15px、`.tip svg` 16px），这里不写宽高。
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 统计卡与列表用到的几个图标。 */
const ICONS = {
  queue: (
    <Icon>
      <path d="M3 12h4l2.5-6 4 12L16 12h5" />
    </Icon>
  ),
  cpu: (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </Icon>
  ),
  clock: (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Icon>
  ),
  check: (
    <Icon>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  ),
  box: (
    <Icon>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M4 10h16M10 10v10" />
    </Icon>
  ),
} as const;

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
 * 投递失败在「说明」里的样子。
 *
 * 限流要等、网络失败要查链路，两者不能共用一句「失败」，否则运维会去查一条其实好好的链路，
 * 或者在限流窗口里反复重投。颜色也不同：限流是提醒，网络失败是错误。
 */
const DISPATCH_FAILURE_STYLE: Record<
  DispatchFailureKind,
  { tone: string; title: string; detail: string }
> = {
  rate_limited: {
    tone: "dot is-warn",
    title: "等待限流",
    detail: "CRP 限流，等窗口过去再投",
  },
  network: {
    tone: "dot is-bad",
    title: "网络失败",
    detail: "连不上 CRP，等下一轮再投",
  },
  failed: {
    tone: "dot is-bad",
    title: "投递失败",
    detail: "CRP 没有收下这次投递，原因见调度事件流水",
  },
};

/** 依赖流里一行的状态色：原型只有「已完成 / 失败 / 等待」三档。 */
const DEP_ROW_TONE: Record<StagePhase, string> = {
  success: "is-done",
  failed: "is-fail",
  waiting: "is-wait",
  queued: "is-wait",
  // 构建中既不是等待也不是终态：原型没给这一档配色，保持序号节点的默认样子，
  // 状态由右侧的色点说明。
  running: "",
  other: "is-wait",
};

/** 状态点的色档。构建中用强调色，与「等待」区分开。 */
const DOT_TONE: Record<StagePhase, string> = {
  success: "is-ok",
  failed: "is-bad",
  running: "is-run",
  waiting: "is-wait",
  queued: "is-wait",
  other: "is-wait",
};

/**
 * 一条提测的状态色档。与任务的 `StagePhase` 不是一套取值：
 * 提测还有「部分成功」「已放弃」两档，不能拿任务的阶段去套。
 */
const RELEASE_DOT_TONE: Record<string, string> = {
  pending: "is-wait",
  dispatching: "is-run",
  building: "is-run",
  success: "is-ok",
  partial_failure: "is-bad",
  failed: "is-bad",
  abandoned: "is-wait",
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

/**
 * 状态点里的文字。
 *
 * `.dot` 是 `white-space: nowrap` 的一行：文字一长，`.dep-row` 的第三列就按最长内容撑开，
 * 中间的包名被挤成一列（375 宽度下实测过）。所以状态点只放状态词 ——
 * 「已阻断（上游 kwin 失败）」截在括号前，括号里的细节留给 `.dep-note` 与作业说明。
 */
function dotLabel(stage: string): string {
  const cut = stage.indexOf("（");

  return cut === -1 ? stage : stage.slice(0, cut);
}

/** 一个包的完整上游名单：拓扑视图要的是全部上游，不只是还没成功的那些。 */
function upstreamsOf(release: QueueReleaseView, packageName: string): string[] {
  return release.edges.filter((edge) => edge.to === packageName).map((edge) => edge.from);
}

/** 包名 → 任务：依赖顺序里给的是包名，要换成那一行的数据。 */
function indexByPackage(release: QueueReleaseView): Map<string, QueueTaskRow> {
  return new Map(release.tasks.map((task) => [task.packageName, task] as const));
}

/** 上游说明：没有上游、上游失败、上游已全部成功、还在等某几个上游。 */
function depNote(
  release: QueueReleaseView,
  task: QueueTaskRow,
  byPackage: ReadonlyMap<string, QueueTaskRow>,
): string {
  const upstreams = upstreamsOf(release, task.packageName);

  if (upstreams.length === 0) {
    return "无上游依赖，直接投递";
  }

  const failed = upstreams.filter((name) => byPackage.get(name)?.phase === "failed");

  if (failed.length > 0) {
    return `上游 ${failed.join("、")} 失败，本包不再投递`;
  }

  if (task.waitingFor.length === 0) {
    return `上游 ${upstreams.join("、")} 已全部成功`;
  }

  return `上游 ${task.waitingFor.join("、")} 未完成`;
}

/** 依赖拓扑里的一行：序号、软件包与上游说明、当前状态点。 */
function depRow(
  release: QueueReleaseView,
  task: QueueTaskRow,
  index: number,
  byPackage: ReadonlyMap<string, QueueTaskRow>,
) {
  return (
    <div className={`dep-row ${DEP_ROW_TONE[task.phase]}`} key={task.snapshotId}>
      <div className="dep-n num" aria-hidden="true">
        {index + 1}
      </div>
      <div>
        <div className="dep-name">{task.packageName}</div>
        <div className="dep-note">{depNote(release, task, byPackage)}</div>
      </div>
      <div>
        <span className={`dot ${DOT_TONE[task.phase]}`}>{dotLabel(task.stage)}</span>
      </div>
    </div>
  );
}

/**
 * 作业列表的说明行：哪个项目、现在什么进度，有失败原因就接在后面。
 *
 * 构建任务的失败原因优先；还没有构建任务时看这个包最近一次投递失败 ——
 * 限流与网络失败各自带一个色点，扫一眼就能分清「等一等」和「去查链路」。
 */
function taskDesc(release: QueueReleaseView, task: QueueTaskRow) {
  const style =
    task.dispatchFailure === null ? null : DISPATCH_FAILURE_STYLE[task.dispatchFailure.kind];

  return (
    <div className="qi-desc">
      {release.projectName} · {task.progress ?? dotLabel(task.stage)}
      {task.reason === null ? null : <> · {task.reason}</>}
      {style === null ? null : (
        <>
          {" · "}
          <span className={style.tone}>{style.title}</span> {style.detail}
        </>
      )}
    </div>
  );
}

/** 构建作业列表里的一行：图标、软件包与进度、耗时。 */
function queueItem(release: QueueReleaseView, task: QueueTaskRow) {
  const percent = task.progressPercent;

  return (
    <div className="queue-item" key={task.snapshotId}>
      <div className="qi-ico" aria-hidden="true">
        {ICONS.box}
      </div>
      <div className="queue-info">
        <div className="qi-name">
          <b>{task.packageName}</b>
          <small className="num">{release.version}</small>
        </div>
        {taskDesc(release, task)}
        <div className="qi-bar">
          <progress
            value={percent ?? 0}
            max={100}
            aria-label={`${task.packageName} 构建进度`}
          />
          <span className="qi-pct num">{percent === null ? "—" : `${percent}%`}</span>
        </div>
      </div>
      <div className="qi-meta">
        <b>{formatDuration(task.durationMs)}</b>
        <small>{dotLabel(task.stage)}</small>
      </div>
    </div>
  );
}

function eventRow(event: BuildPollEventRow) {
  return (
    <tr key={event.id}>
      <td className="num col-mono">{formatTime(event.createdAt)}</td>
      <td>{event.releaseVersion === null ? "—" : <code>{event.releaseVersion}</code>}</td>
      <td>{event.packageName === null ? "—" : <code>{event.packageName}</code>}</td>
      <td>{eventLabel(event.event)}</td>
      <td>{event.condition}</td>
      <td>{event.result}</td>
    </tr>
  );
}

/** 一张统计卡：数字在上、说明在下、图标在右。 */
function StatCard(props: {
  label: string;
  value: number;
  foot: string;
  icon: keyof typeof ICONS;
  tone: string;
}) {
  return (
    <div className="stat">
      <div className="stat-main">
        <div className="stat-label">{props.label}</div>
        <div className="stat-value num">{props.value}</div>
        <div className="stat-foot">{props.foot}</div>
      </div>
      <div className={`stat-ico ${props.tone}`} aria-hidden="true">
        {ICONS[props.icon]}
      </div>
    </div>
  );
}

/**
 * 「依赖与投递顺序」面板头里的版本提示。
 *
 * 原型这一页只演一条提测，所以写死「v25_kwin / 25.0.3」。真实页面同时排着多条提测，
 * 提示给最新投递的那条（列表按创建时间从新到旧），条数多于一条时说明还有别的。
 */
function depsHint(releases: readonly QueueReleaseView[]): string {
  const newest = releases[0];

  if (newest === undefined) {
    return "当前没有未完结的提测";
  }

  const base = `${newest.projectName} / ${newest.version}`;

  return releases.length === 1 ? base : `最新：${base}，共 ${releases.length} 条`;
}

/**
 * 一条提测的依赖流。
 *
 * 多条提测同时排队时，原型那份单条的样子不够用，所以每条前面加一行 `.sec-hd`：
 * 项目 · 版本 + 提测状态点。行内顺序仍是原型的三段。
 */
function releaseBlock(release: QueueReleaseView) {
  const byPackage = indexByPackage(release);

  return (
    <section key={release.releaseId}>
      <div className="sec-hd">
        <h3>
          {release.projectName} · <code>{release.version}</code>
        </h3>
        <span className={`dot ${RELEASE_DOT_TONE[release.status] ?? "is-wait"}`}>
          {release.statusLabel}
        </span>
      </div>
      {release.tasks.length === 0 ? (
        <div className="empty">这条提测还没有软件包。</div>
      ) : (
        <div className="dep-flow">
          {release.order.map((name, index) => {
            const task = byPackage.get(name);

            return task === undefined ? null : depRow(release, task, index, byPackage);
          })}
        </div>
      )}
    </section>
  );
}

export type QueueBoardProps = {
  view: BuildQueueView;
  /** 当前工作区，用来拼「重排」的链接，点完留在同一个工作区。 */
  workspaceSlug: string;
};

/**
 * 「重排」按钮的目标地址。
 *
 * 依赖顺序由 `lib/build/queue.ts` 每次读库时按依赖重新算出来（`sortByDependencies`），
 * 库里没有「顺序」这个字段可以改，所以这个按钮真的很轻：重新读一遍依赖再算一次。
 * 它**不挂轮询动作** —— 「立即轮询」会真的向 CRP 建 Topic、投 Release，
 * 一个写着「重排」的按钮去启动构建是骗人的。
 */
function reorderHref(workspaceSlug: string): string {
  return workspaceSlug === "" ? "/queue" : `/queue?workspace=${encodeURIComponent(workspaceSlug)}`;
}

/** 四张统计卡：数字与下面的列表出自同一次查询，不会「卡上一个数、表里另一个数」。 */
function StatsStrip({ stats }: { stats: BuildQueueStats }) {
  return (
    <div className="stats" data-style-anchor="queue.stats">
      <StatCard
        label="队列任务"
        value={stats.queued}
        foot="还没到终态的包"
        icon="queue"
        tone="is-accent"
      />
      <StatCard
        label="正在构建"
        value={stats.building}
        foot="含投递中"
        icon="cpu"
        tone="is-warn"
      />
      <StatCard
        label="等待依赖"
        value={stats.waiting}
        foot="卡在上游没成功"
        icon="clock"
        tone=""
      />
      <StatCard
        label="今日已完成"
        value={stats.finishedToday}
        foot="今天（UTC）拿到终态的构建"
        icon="check"
        tone="is-ok"
      />
    </div>
  );
}

/** 「依赖与投递顺序」：每条提测一段依赖流，末尾是调度规则说明。 */
function DepsPanel({
  releases,
  workspaceSlug,
}: {
  releases: readonly QueueReleaseView[];
  workspaceSlug: string;
}) {
  return (
    <div className="panel" data-style-anchor="queue.topo">
      <div className="panel-hd">
        <h2>依赖与投递顺序</h2>
        <span className="hint">{depsHint(releases)}</span>
        <div className="spacer" />
        <Link
          className="btn btn-sm"
          href={reorderHref(workspaceSlug)}
          title="重新读取依赖关系，重新计算投递顺序"
        >
          重排
        </Link>
      </div>

      <div className="panel-bd stack">
        {releases.length === 0 ? (
          <div className="empty">当前没有未完结的提测。已完结的提测不再轮询，也不再占队列。</div>
        ) : (
          releases.map((release) => releaseBlock(release))
        )}

        <p className="hint">
          本次提测包含项目清单中的全部软件。清单内的依赖按软件包记录的顺序提交，并等待上游完成；
          清单外的依赖使用目标 CRP 仓库中已有版本，不扩展本次提测清单。失败时阻断下游任务并通知提测创建人。
        </p>
      </div>
    </div>
  );
}

/** 「构建作业」：所有未完结提测里的包，按实际可执行顺序排；空时给空状态。 */
function JobsPanel({ view }: { view: BuildQueueView }) {
  const tasks = view.releases.flatMap((release) =>
    release.tasks.map((task) => ({ release, task })),
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>构建作业</h2>
        <span className="hint">
          进行中 {view.stats.building} 个，等待 {view.stats.waiting} 个
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="empty">没有要展示的任务。</div>
      ) : (
        <div className="queue-list" data-style-anchor="queue.task-list">
          {tasks.map(({ release, task }) => queueItem(release, task))}
        </div>
      )}
    </div>
  );
}

/** 「调度事件」：平台生成的流水，最近 30 条，列数与真实字段一致（不照原型的 4 列裁）。 */
function EventsPanel({
  events,
  generatedAt,
}: {
  events: readonly BuildPollEventRow[];
  generatedAt: Date;
}) {
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>调度事件</h2>
        <span className="hint">
          最近 {events.length} 条 · 数据截至 {formatTime(generatedAt)} ·
          手动轮询与定时轮询走同一段代码
        </span>
      </div>

      {events.length === 0 ? (
        <div className="empty">
          还没有调度记录。定时轮询跑过一轮之后，这里会记下每一轮做了什么。
        </div>
      ) : (
        <div className="panel-bd flush table-scroll" data-style-anchor="queue.event-table">
          <table className="grid">
            <thead>
              <tr>
                <th className="num">时间</th>
                <th>提测</th>
                <th>软件包</th>
                <th>事件</th>
                <th>触发条件</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>{events.map((event) => eventRow(event))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * 构建队列页的正文：统计卡 → 依赖与投递顺序 → 构建作业 → 限流提示 → 调度事件。
 *
 * 顺序与原型一致；每一块自己拿着需要的数据，页面的组合只做一件事 —— 按原型把五块竖着摆开。
 */
export function QueueBoard({ view, workspaceSlug }: QueueBoardProps) {
  return (
    <div className="stack">
      <StatsStrip stats={view.stats} />
      <DepsPanel releases={view.releases} workspaceSlug={workspaceSlug} />
      <JobsPanel view={view} />

      <div className="tip">
        {ICONS.clock}
        <div>
          <b>限流时会等。</b>
          CRP 对投递接口有频率限制，被限流后平台会等到窗口结束再重试，队列上会显示「等待限流」而不是失败。
        </div>
      </div>

      <EventsPanel events={view.events} generatedAt={view.generatedAt} />
    </div>
  );
}
