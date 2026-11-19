/**
 * Shuttle 的构建状态 → 本平台的 `build_status`。
 *
 * 纯函数：输入是 Shuttle 原样的状态字符串，输出是本平台的状态与一句给人看的说明。
 * 映射表只在 `build_task.status` / `build_job.status` 这一处定义，投递、轮询、构建队列页共用。
 *
 * 只有实测见过的值才写进明确的那一档（见 `lib/integrations/shuttle/FINDINGS.md`）：
 * 任务状态见过 `UPLOAD_GIVEUP`，作业状态见过 `BUILD_OK`、`FAILED`。
 * **没见过的状态一律当「还在构建」**：把未知状态当成失败会让下游被错误阻断，
 * 而当成构建中最多是等下一轮再查，代价小得多。
 */

/** 本平台的状态取值，与 `build_status` 枚举一致。这里不 import Prisma 生成物，纯模块保持无依赖。 */
export type BuildStateName = "pending" | "building" | "success" | "failed" | "canceled";

/** Shuttle 表示「成功」的状态。 */
const SUCCESS_STATES = new Set([
  "BUILD_OK",
  "BUILD_SUCCESS",
  "BUILD_SUCCEEDED",
  "UPLOAD_OK",
  "UPLOAD_SUCCESS",
  "UPLOAD_DONE",
  "SUCCESS",
]);

/** Shuttle 表示「失败」的状态。 */
const FAILED_STATES = new Set([
  "FAILED",
  "BUILD_FAILED",
  "BUILD_ERROR",
  "UPLOAD_FAILED",
  "UPLOAD_GIVEUP",
  "UPLOAD_ERROR",
]);

/** Shuttle 表示「已取消 / 已终止」的状态。 */
const CANCELED_STATES = new Set([
  "CANCELED",
  "CANCELLED",
  "TERMINATED",
  "BUILD_TERMINATED",
  "KILLED",
]);

/** 单个 Shuttle 状态的归类结果。未知状态算「还在构建」。 */
export function mapShuttleState(state: string): BuildStateName {
  const key = state.trim().toUpperCase();

  if (SUCCESS_STATES.has(key)) {
    return "success";
  }

  if (FAILED_STATES.has(key)) {
    return "failed";
  }

  if (CANCELED_STATES.has(key)) {
    return "canceled";
  }

  // 空串表示 Shuttle 还没给出状态，与非空但没见过的值同样处理。
  return "building";
}

/** 一次查询得到的构建任务全貌，字段取自 Shuttle `POST /task/list`。 */
export type BuildSnapshot = {
  /** Shuttle 任务状态，例如 `UPLOAD_GIVEUP`。 */
  taskState: string;
  /** 各架构作业的状态，例如 `["BUILD_OK", "FAILED"]`。 */
  jobStates: readonly string[];
  /**
   * 第一次看到这个构建任务的时间，用于「任务成功、作业列表为空」的兜底判定。
   * 不传表示不做兜底（纯状态映射）；生产代码传 `build_task.started_at`。
   */
  waitingSince?: Date | null;
  /** 本次查询的时间。与 `waitingSince` 一起算出已经等了多久。 */
  observedAt?: Date;
};

/**
 * 「任务成功、作业列表一直为空」时最多再等多久。
 *
 * 这种返回形态原本没有任何出口：任务说成功、作业一条都没有，代码就永远判「构建中」，
 * 整条提测卡在那里。作业列表迟迟不出现意味着 CRP 侧没有产出这个包的产物，
 * 所以等过这个期限就判失败（下游被阻断），不能冒认成功——那会让下游基于一个不存在的产物构建。
 *
 * 期限从第一次看到构建任务算起，明显大于一次 Shuttle 状态同步的延迟。
 */
export const EMPTY_JOB_LIST_GRACE_MS = 15 * 60 * 1000;

/** 汇总后的结论。`reason` 只在失败或取消时给人看，成功与进行中为空。 */
export type BuildVerdict = {
  status: BuildStateName;
  reason: string | null;
};

/** 已经等了多久：只有给了起点与当前时间、且超过期限才算「等太久」。 */
function waitedTooLong(snapshot: BuildSnapshot): boolean {
  if (snapshot.waitingSince == null || snapshot.observedAt == null) {
    return false;
  }

  return snapshot.observedAt.getTime() - snapshot.waitingSince.getTime() >= EMPTY_JOB_LIST_GRACE_MS;
}

/**
 * 一个构建任务的结论。
 *
 * 判定顺序是「先看有没有失败，再看是不是全部成功」：任务有多个架构的作业，
 * 只要有一个作业失败，这个包就算构建失败——部分架构缺包不能当成功投给下游。
 * 任务自身状态与作业状态都要看：实测出现过任务 `UPLOAD_GIVEUP` 而作业 `FAILED` 的组合。
 */
export function summarizeBuild(snapshot: BuildSnapshot): BuildVerdict {
  const taskState = mapShuttleState(snapshot.taskState);
  const jobStates = snapshot.jobStates.map(mapShuttleState);
  const failedJobs = jobStates.filter((state) => state === "failed").length;

  if (taskState === "failed") {
    return {
      status: "failed",
      reason: `Shuttle 任务状态为 ${snapshot.taskState || "未知"}，构建失败`,
    };
  }

  if (failedJobs > 0) {
    return {
      status: "failed",
      reason: `Shuttle 有 ${failedJobs} 个架构的作业失败`,
    };
  }

  if (taskState === "canceled" || jobStates.includes("canceled")) {
    return { status: "canceled", reason: "构建已被终止" };
  }

  if (taskState === "success") {
    if (jobStates.length > 0 && jobStates.every((state) => state === "success")) {
      return { status: "success", reason: null };
    }

    // 任务说成功、作业一条都没报：给一段等待期，过了就判失败（没有产物，下游不能用）。
    if (jobStates.length === 0 && waitedTooLong(snapshot)) {
      return {
        status: "failed",
        reason: `Shuttle 任务已成功，但 ${Math.round(
          EMPTY_JOB_LIST_GRACE_MS / 60_000,
        )} 分钟内没有任何架构的作业上报，构建失败`,
      };
    }

    // 任务说成功、作业还没报完：继续等，不下结论。
    return { status: "building", reason: null };
  }

  // 任务还没成功、作业也没失败：仍在构建（含 Shuttle 还没建出任务的情况）。
  return { status: "building", reason: null };
}
