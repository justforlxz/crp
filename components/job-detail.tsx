"use client";

/**
 * 队列条目与依赖节点的弹窗（MKACG-1012）：工作台与构建队列两页共用同一个组件。
 *
 * 补的是两处「点了没反应」，结构照 `.agents/spec/design/prototype.html` 的 `jobModal` 与 `depModal`：
 *
 * - 队列条目 → **作业详情**：四格概要（状态、架构进度、已用时间、CRP Topic）+ 每架构一行
 *   （架构、状态点、说明）+ 重投按钮；构建中禁用并写明原因。
 * - 依赖节点 → **依赖说明**：上游是谁、当前状态、排序依据、为什么不能手动提前。
 *
 * 弹层本体复用 `components/modal.tsx`：×、点遮罩空白处、Esc 三种关闭方式都在那儿。
 * 色点档位与状态说明复用 `components/task-display.ts`，与列表同一个阶段不会两处两种颜色。
 *
 * 为什么这个文件是客户端组件：开弹窗、发重投请求都是浏览器里的行为。行的内容由服务端的
 * 那两页当 `children` 传进来，类名与层级仍写在页面源码里 —— `pnpm check:modules` 只从
 * `className` 里读模块名，结构藏进这个文件它就读不到了。
 *
 * 数据全是真的：架构数、已完成数、Topic、耗时都来自库里那一行。原型里写死的「6 个架构」
 * 与「68%」一个都没照抄 —— 还没投递的包没有架构作业，弹窗就说清「还不知道有几个」。
 *
 * 重投走的是既有的 `POST /api/releases/{id}/dispatch?action=retry`（`retryFailedTasks`）：
 * 它按提测重投所有失败的包，并把被阻断的包放回队列，所以提示文案据实说明「同一次提测里的
 * 其它失败包也会一起重投」。单包重投是 MKACG-1011 在提测详情页做的事，这里不复制一份。
 */

import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { readErrorMessage } from "@/app/http-error";
import type { QueueTaskRow } from "@/lib/build";
import { formatDuration } from "@/lib/build/duration";
import { buildStatusLabel, type StagePhase } from "@/lib/build/stage";

import { Icon } from "./icons";
import { Modal } from "./modal";
import { archDotTone, archNote, DOT_TONE, shortStageLabel } from "./task-display";
import { Toast } from "./toast";

/** 重投接口回的字段，只取这个弹窗要用到的几个（见 `app/api/releases/[id]/dispatch/route.ts`）。 */
type RetryResponse = {
  resetPackageNames?: string[];
  failures?: Array<{ packageName: string; reason: string }>;
};

export type RetryState = {
  enabled: boolean;
  /** 不能点时写给人看的原因；能点时为空。 */
  reason: string | null;
};

/**
 * 重投按钮该不该能点、不能点时写什么原因。
 *
 * 只有「自己真的失败」的包能重投：构建中的不能、已经成功的没必要、还在排队的没有作业可重投。
 * 被上游阻断的包也不单独重投 —— 它自己没有失败，上游重投成功后会自动回到队列
 * （与 `retryFailedTasks` 的口径一致）。
 */
export function retryStateOf(job: Pick<QueueTaskRow, "phase" | "blockedBy">): RetryState {
  if (job.phase === "running") {
    return { enabled: false, reason: "这个包正在构建，构建中的作业不能重投。" };
  }

  if (job.phase === "failed") {
    if (job.blockedBy !== null) {
      return {
        enabled: false,
        reason: `上游 ${job.blockedBy} 失败阻断了这个包；重投上游之后，它会自己回到队列。`,
      };
    }

    return { enabled: true, reason: null };
  }

  if (job.phase === "success") {
    return { enabled: false, reason: "这个包已经构建成功，没有要重投的架构。" };
  }

  if (job.phase === "queued") {
    return { enabled: false, reason: "这个包还没投出去，下一轮调度会自动投递。" };
  }

  return { enabled: false, reason: "这个包还在等上游完成，投出去之后才有可重投的作业。" };
}

/** 一个架构那一行的说明：失败时优先写真实原因（来自构建任务），其余写状态词。 */
function archRowNote(job: QueueTaskRow, status: string): string {
  return status === "failed" && job.reason !== null ? job.reason : archNote(status);
}

/** 还没有架构作业时的说明：被阻断、没建 Topic、还是没投递 —— 三种原因不能混成一句。 */
function archEmptyNote(job: QueueTaskRow): string {
  if (job.blockedBy !== null) {
    return `上游 ${job.blockedBy} 失败，这个包被阻断，不会创建构建作业。`;
  }

  if (job.topicId === null) {
    return "这次提测还没建 CRP Topic，投递之后才会创建架构作业。";
  }

  return "这个包还没有投递，投出去之后才会创建架构作业。";
}

/** 已用时间、架构进度这些数字在概要格里都按等宽数字显示（design.md 第六节）。 */
function SummaryCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="summary-cell">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export type JobDetailModalProps = {
  /** 队列里的一行：工作台的摘要行与队列页的任务行是同一个形状。 */
  job: QueueTaskRow;
  onClose: () => void;
};

/** 作业详情弹窗：四格概要、每个架构一行、底部重投。 */
export function JobDetailModal({ job, onClose }: JobDetailModalProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const retry = retryStateOf(job);
  const progress = job.archProgress;

  async function handleRetry(): Promise<void> {
    setPending(true);
    setMessage(null);

    const response = await fetch(`/api/releases/${job.releaseId}/dispatch?action=retry`, {
      method: "POST",
    });

    setPending(false);

    if (!response.ok) {
      setMessage({
        tone: "bad",
        text: await readErrorMessage(response, "重投失败，接口没有返回原因。"),
      });
      return;
    }

    const body = (await response.json().catch(() => null)) as RetryResponse | null;
    const failures = body?.failures ?? [];
    const reset = body?.resetPackageNames ?? [];

    if (failures.length > 0) {
      setMessage({
        tone: "bad",
        text: `有 ${failures.length} 个包没重投成功：${failures
          .map((item) => `${item.packageName}（${item.reason}）`)
          .join("；")}`,
      });
    } else {
      const others = reset.filter((name) => name !== job.packageName);

      setMessage({
        tone: "ok",
        text:
          others.length === 0
            ? `已重新投递 ${job.packageName}。`
            : `已重新投递 ${job.packageName}；这次提测里另外 ${others.length} 个失败的包（${others.join(
                "、",
              )}）也一起重投了。`,
      });
    }

    // 重投会把快照退回「待投递」再重投，列表与这弹窗都该按新状态显示。
    router.refresh();
  }

  return (
    <>
      <Modal
        className="modal"
        title={
          <>
            {job.packageName} <span className="modal-sub num">{job.releaseVersion}</span>
          </>
        }
        onClose={onClose}
        footer={
          <>
            {retry.reason === null ? null : <span className="hint">{retry.reason}</span>}
            <div className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!retry.enabled || pending}
              onClick={() => void handleRetry()}
            >
              {pending ? "投递中…" : "重新投递这个包"}
            </button>
          </>
        }
      >
        <div className="stack">
          <dl className="summary-strip">
            <SummaryCell label="状态">
              <span className={`dot ${DOT_TONE[job.phase]}`}>{shortStageLabel(job.stage)}</span>
            </SummaryCell>
            <SummaryCell label="架构进度">
              <span className="num">
                {progress === null ? "—" : `${progress.done}/${progress.total}`}
              </span>
            </SummaryCell>
            <SummaryCell label="已用时间">
              <span className="num">{formatDuration(job.durationMs)}</span>
            </SummaryCell>
            <SummaryCell label="CRP Topic">
              <span className="num">{job.topicId === null ? "还没建" : `#${job.topicId}`}</span>
            </SummaryCell>
          </dl>

          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>架构</th>
                  <th>状态</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {job.arches.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      {archEmptyNote(job)}
                    </td>
                  </tr>
                ) : (
                  job.arches.map((arch) => (
                    <tr key={arch.arch}>
                      <td className="col-mono">{arch.arch}</td>
                      <td>
                        <span className={`dot ${archDotTone(arch.status)}`}>
                          {buildStatusLabel(arch.status)}
                        </span>
                      </td>
                      <td className="muted">{archRowNote(job, arch.status)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="tip">
            <Icon name="info" />
            <div>
              {job.reason === null ? null : (
                <>
                  <b>失败原因：{job.reason}</b>
                  <br />
                </>
              )}
              <b>重投会删掉这个包在 CRP 上的旧 Release，再按同一份提测参数重新投一次。</b>
              同一次提测里其它失败的包也会一起重投，被阻断的包会退回队列；已经成功的包不受影响。
            </div>
          </div>
        </div>
      </Modal>

      {message === null ? null : (
        <div className="toast-stack">
          <Toast
            className={`toast ${message.tone}`}
            message={message.text}
            role={message.tone === "bad" ? "alert" : "status"}
          />
        </div>
      )}
    </>
  );
}

export type DepDetailModalProps = {
  packageName: string;
  /** 在依赖顺序里排第几位（从 1 起）。 */
  position: number;
  /** 全部上游包名；没有上游时是空数组。 */
  upstreams: readonly string[];
  /** 阶段名与它的分类，与列表里的色点同一份。 */
  stage: string;
  phase: StagePhase;
  /** 上游说明，与列表里 `.dep-note` 同一句。 */
  note: string;
  onClose: () => void;
};

/** 依赖说明弹窗：为什么排在这、为什么要等。 */
export function DepDetailModal({
  packageName,
  position,
  upstreams,
  stage,
  phase,
  note,
  onClose,
}: DepDetailModalProps) {
  return (
    <Modal
      className="modal"
      title={packageName}
      subtitle={`第 ${position} 位`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="confirm-card">
        <div className="cfg-row">
          <div>
            <small>上游依赖</small>
            <b>{upstreams.length === 0 ? "无，可以直接投递" : upstreams.join("、")}</b>
          </div>
          <div>
            <small>当前状态</small>
            <b>
              <span className={`dot ${DOT_TONE[phase]}`}>{shortStageLabel(stage)}</span>
            </b>
          </div>
        </div>
        <div className="cfg-row">
          <div>
            <small>排序依据</small>
            <b>软件包登记里配的依赖关系</b>
          </div>
          <div>
            <small>能不能手动提前</small>
            <b>不能，用户改不了顺序</b>
          </div>
        </div>
      </div>

      <div className="tip">
        <Icon name="info" />
        <div>
          <b>{note}</b>
          <br />
          上游成功之后这一包会自动投递，不需要人再点一次。
        </div>
      </div>
    </Modal>
  );
}

export type JobQueueItemProps = {
  /** 队列里的一行。 */
  job: QueueTaskRow;
  /**
   * 行的容器类名，由页面给（`queue-item is-clickable`）。
   *
   * 与 `Toast` 同一条规矩：模块归属按页面算 —— `pnpm check:modules` 只从页面源码的
   * `className` 里读模块名，类名藏进这个组件它就读不到了。
   */
  className: string;
  /** 行内容：图标、软件包与进度、耗时。 */
  children?: ReactNode;
};

/** 可点的队列条目：点开作业详情。行内容（图标、进度、耗时）仍由页面给。 */
export function JobQueueItem({ job, className, children }: JobQueueItemProps) {
  const [open, setOpen] = useState(false);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <div
        className={className}
        role="button"
        tabIndex={0}
        title={`查看 ${job.packageName} 的作业详情`}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
      {open ? <JobDetailModal job={job} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export type DepQueueRowProps = Omit<DepDetailModalProps, "onClose"> & {
  /** 行的容器类名，由页面给（`dep-row is-done` 这类）。理由同 `JobQueueItem`。 */
  className: string;
  /** 行内容：序号、包名与上游说明、状态点。 */
  children?: ReactNode;
};

/** 可点的依赖节点：点开依赖说明。三列内容（序号、包名与上游说明、状态点）仍由页面给。 */
export function DepQueueRow({ className, children, ...row }: DepQueueRowProps) {
  const [open, setOpen] = useState(false);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <div
        className={className}
        role="button"
        tabIndex={0}
        title={`查看 ${row.packageName} 的依赖说明`}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
      {open ? <DepDetailModal {...row} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
