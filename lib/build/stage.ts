/**
 * 快照状态 → 队列页上的阶段名。
 *
 * 纯函数：输入是快照状态、上游是否已全部成功、因哪个上游被阻断，输出页面直接显示的一档。
 * 这套名字只在 `lib/build` 里定义一处，队列页、提测详情页的构建状态区块、调度事件流水共用，
 * 免得同一行数据在三个地方有三种说法。
 *
 * 阶段与 `snapshot_status` 不是一对一：「待投递」与「等待依赖」都是 `pending`，
 * 区别在于上游有没有全成功 —— 这正是「谁在等谁」要回答的问题。
 */

/** 阶段分类。统计卡按它计数，不再自己去比对状态字符串。 */
export type StagePhase =
  /** 还没投出去，在等上游构建成功。 */
  | "waiting"
  /** 可以投但还没投（上游已全部成功）。 */
  | "queued"
  /** 投递中或构建中。 */
  | "running"
  | "success"
  | "failed"
  /** 已被新一轮替换、已放弃，或暂时认不出的状态。 */
  | "other";

export type QueueStage = {
  phase: StagePhase;
  /** 页面上显示的名字。 */
  name: string;
};

/** 快照状态的中文名。取值与 `snapshot_status` 枚举一致。 */
const SNAPSHOT_STATUS_LABELS: Record<string, string> = {
  pending: "待投递",
  dispatching: "投递中",
  building: "构建中",
  success: "成功",
  failed: "失败",
  abandoned: "已放弃",
  superseded: "已被替换",
};

/** 快照状态的中文名；没见过的状态原样带出来，不吞掉。 */
export function snapshotStatusLabel(status: string): string {
  return SNAPSHOT_STATUS_LABELS[status] ?? `未知状态（${status}）`;
}

export type QueueStageInput = {
  /** 快照状态，取值与 `snapshot_status` 枚举一致。 */
  snapshotStatus: string;
  /** 本提测内的上游是否已全部成功；没有上游时为 `true`。 */
  upstreamReady: boolean;
  /** 因上游失败被阻断时的上游包名；不是被阻断的传 `null`。 */
  blockedBy: string | null;
};

/**
 * 合成队列页上的阶段。
 *
 * 被阻断的包在库里是 `failed`（A12 判定阻断时就写失败），但它并没有真的去构建过，
 * 页面上必须与「构建失败」区分开，否则看不出是上游拖垮的。
 */
export function queueStageOf(input: QueueStageInput): QueueStage {
  if (input.blockedBy !== null) {
    return { phase: "failed", name: `已阻断（上游 ${input.blockedBy} 失败）` };
  }

  switch (input.snapshotStatus) {
    case "pending":
      return input.upstreamReady
        ? { phase: "queued", name: "待投递" }
        : { phase: "waiting", name: "等待依赖" };
    case "dispatching":
      return { phase: "running", name: "投递中" };
    case "building":
      return { phase: "running", name: "构建中" };
    case "success":
      return { phase: "success", name: "成功" };
    case "failed":
      return { phase: "failed", name: "失败" };
    default:
      return { phase: "other", name: snapshotStatusLabel(input.snapshotStatus) };
  }
}

/** 提测状态的中文名。取值与 `release_status` 枚举一致。 */
const RELEASE_STATUS_LABELS: Record<string, string> = {
  pending: "待建 Topic",
  dispatching: "投递中",
  building: "构建中",
  success: "全部成功",
  partial_failure: "部分成功",
  failed: "失败",
  abandoned: "已放弃",
};

/** 提测状态的中文名；没见过的状态原样带出来。 */
export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABELS[status] ?? `未知状态（${status}）`;
}

/** 构建状态的中文名。取值与 `build_status` 枚举一致（构建任务与构建作业共用）。 */
const BUILD_STATUS_LABELS: Record<string, string> = {
  pending: "待开始",
  building: "构建中",
  success: "成功",
  failed: "失败",
  canceled: "已取消",
};

/** 构建状态的中文名；没见过的状态原样带出来。 */
export function buildStatusLabel(status: string): string {
  return BUILD_STATUS_LABELS[status] ?? `未知状态（${status}）`;
}
