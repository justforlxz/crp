/**
 * 构建调度事件流水：轮询这一轮做了什么，落到 `build_poll_event`。
 *
 * 设计契约 MUST 要求记录「时间、软件包、事件、触发条件、结果」。时间由 `createdAt` 自动给，
 * 另外四个字段由调用方填：`packageName`、`event`、`condition`、`result`。
 *
 * 六种事件：轮询三类，投递失败三类（MKACG-931 追加，队列页据此把「限流等待」与
 * 「网络失败」分开显示）。
 *
 * | 事件 | 谁写 | 说明 |
 * | --- | --- | --- |
 * | `poll` | 每轮每条提测一条 | 轮询本身，失败时 `result` 是错误摘要 |
 * | `status` | 某个包的状态变了才写 | `result` 是「旧阶段 → 新阶段」，状态没变不写，避免流水被刷屏 |
 * | `progress` | 每轮每条提测一条 | `crp_work_progress` 的回写结果，失败时写明保留的旧值 |
 * | `dispatch_rate_limited` | 投递某个包拿到 CRP 限流（429）时写 | 限流窗口里只能等，重发只会加压 |
 * | `dispatch_network_failed` | 投递某个包时 CRP 连不上、超时或读不出响应时写 | 要去查链路，不是等 |
 * | `dispatch_failed` | 其它投递失败（CRP 拒绝、服务端出错、本地参数不合法）时写 | 重发同一份请求没有用，要改参数或配置 |
 *
 * 流水只追加、不改，所以必须有人管老行：`prunePollEvents()` 按保留期删掉过期的，
 * 由 `runBuildPoll()` 每轮调一次：轮询本身就是那只手，不再单独引入定时器或新依赖。
 * 保留期见 `POLL_EVENT_RETENTION_DAYS` 与 `docs/DATA_MODEL.md` 4.22。
 */

import { prisma } from "../db";

/** 事件类型，取值与本模块文件头那张表一致。 */
export type BuildPollEventName =
  | "poll"
  | "status"
  | "progress"
  | "dispatch_rate_limited"
  | "dispatch_network_failed"
  | "dispatch_failed";

export type BuildPollEventInput = {
  releaseId: string;
  /** 针对哪一轮快照；整条提测级别的事件不传。 */
  snapshotId?: string | null;
  /** 软件包名；不针对单个包的事件不传。 */
  packageName?: string | null;
  event: BuildPollEventName;
  /** 触发条件：为什么做了这件事。 */
  condition: string;
  /** 结果：成功了没、得到了什么。 */
  result: string;
};

/**
 * 写一条事件。
 *
 * 写不进去只打进程日志，不打断轮询：事件是旁证，不能因为它写失败就让状态同步停下。
 * 与 `crp_call_log` 同一处理方式。
 */
export async function recordPollEvent(input: BuildPollEventInput): Promise<void> {
  try {
    await prisma.buildPollEvent.create({
      data: {
        releaseId: input.releaseId,
        snapshotId: input.snapshotId ?? null,
        packageName: input.packageName ?? null,
        event: input.event,
        condition: input.condition,
        result: input.result,
      },
    });
  } catch (error) {
    console.error(`[build-poll] 提测 ${input.releaseId} 的调度事件写不进去：`, error);
  }
}

/**
 * 投递失败的分类。与 `lib/integrations/crp/errors.ts` 的错误分类一一对应：
 * 限流只要等，网络失败要查链路，其它是 CRP 明确拒绝或本地参数不合法。
 *
 * 分类写进 `event` 列（而不是拼进文本），读模型与流水都按列取值，
 * 不靠解析人写的中文句子判断是哪一类。
 */
export type DispatchFailureKind = "rate_limited" | "network" | "failed";

/**
 * 三类投递失败各写哪种事件、`condition` 写什么。
 *
 * 一张表管到底：加一类失败时只改这里，写入与查询两端都跟着变。
 */
const DISPATCH_FAILURE_EVENTS: ReadonlyArray<{
  kind: DispatchFailureKind;
  event: BuildPollEventName;
  condition: string;
}> = [
  {
    kind: "rate_limited",
    event: "dispatch_rate_limited",
    condition: "投递这个包时 CRP 限流（HTTP 429）",
  },
  {
    kind: "network",
    event: "dispatch_network_failed",
    condition: "投递这个包时 CRP 请求失败",
  },
  {
    kind: "failed",
    event: "dispatch_failed",
    condition: "投递这个包时 CRP 没有接受（拒绝或服务端出错）",
  },
];

/** 队列页要显示的一条投递失败：哪一类，加上写进流水的原因摘要。 */
export type DispatchFailureMarker = {
  kind: DispatchFailureKind;
  reason: string;
};

/**
 * 记一条投递失败。
 *
 * 投递路径只在原有的失败分支里多调这一个函数：投递结果、重试策略都不变，
 * 只是把「这个包为什么没投出去」落进可查询的流水。
 */
export async function recordDispatchFailure(input: {
  releaseId: string;
  snapshotId: string;
  packageName: string;
  kind: DispatchFailureKind;
  /** 错误摘要，与人工日志里那句一致。 */
  reason: string;
}): Promise<void> {
  const entry = DISPATCH_FAILURE_EVENTS.find((item) => item.kind === input.kind);

  if (entry === undefined) {
    return;
  }

  await recordPollEvent({
    releaseId: input.releaseId,
    snapshotId: input.snapshotId,
    packageName: input.packageName,
    event: entry.event,
    condition: entry.condition,
    result: input.reason,
  });
}

/**
 * 每条快照最近一次投递失败。
 *
 * 流水只追加，「现在还卡着没有」由读模型结合快照状态判断（见 `buildQueueView`）：
 * 投递成功之后快照不再是「待投递」，标记自然消失，不需要回头改历史行。
 *
 * 用 `distinct` 让数据库只回每条快照最新的一行：一个包一直失败时流水会越积越多，
 * 全取回来再筛是把传输量交给排障现场。
 */
export async function loadLatestDispatchFailures(
  snapshotIds: readonly string[],
): Promise<Map<string, DispatchFailureMarker>> {
  if (snapshotIds.length === 0) {
    return new Map();
  }

  const events = DISPATCH_FAILURE_EVENTS.map((item) => item.event);
  const rows = await prisma.buildPollEvent.findMany({
    where: { snapshotId: { in: [...snapshotIds] }, event: { in: events } },
    // `distinct` 要求排序列以去重列开头，否则拿到的不是「最新一条」。
    orderBy: [{ snapshotId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    distinct: ["snapshotId"],
    select: { snapshotId: true, event: true, result: true },
  });

  const markers = new Map<string, DispatchFailureMarker>();

  for (const row of rows) {
    if (row.snapshotId === null) {
      continue;
    }

    const entry = DISPATCH_FAILURE_EVENTS.find((item) => item.event === row.event);

    if (entry === undefined) {
      continue;
    }

    markers.set(row.snapshotId, { kind: entry.kind, reason: row.result });
  }

  return markers;
}

/**
 * 调度事件流水保留多少天。
 *
 * 一条提测的记录从创建到完结以天计，排障与复盘要回答的是「这一轮为什么没动」，
 * 30 天足够覆盖一次提测从建到合的全过程再加一轮复盘。队列页只读最近 30 条，
 * 清理掉更老的行不会让页面少一条。
 */
export const POLL_EVENT_RETENTION_DAYS = 30;

/**
 * 删掉超过保留期的流水，返回删掉的条数。
 *
 * 这张表只追加、每轮每条提测固定写 `poll` 与 `progress` 两条，不清理会随轮询轮次无限增长。
 * 删不掉的只打进程日志，不打断轮询：清理是维护动作，不能因为它失败就把状态同步停下。
 */
export async function prunePollEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - POLL_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const { count } = await prisma.buildPollEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (count > 0) {
      console.info(
        `[build-poll] 清理 ${count} 条早于 ${cutoff.toISOString()} 的调度事件` +
          `（保留 ${POLL_EVENT_RETENTION_DAYS} 天）`,
      );
    }

    return count;
  } catch (error) {
    console.error("[build-poll] 调度事件的过期清理失败：", error);
    return 0;
  }
}

/** 一条流水，页面直接展示。 */
export type BuildPollEventRow = {
  id: string;
  createdAt: Date;
  releaseId: string;
  /** 提测版本号，页面不用再查一次。提测被删过一轮也可能为空。 */
  releaseVersion: string | null;
  snapshotId: string | null;
  packageName: string | null;
  event: string;
  condition: string;
  result: string;
};

/**
 * 一个工作区最近的调度事件，按时间从新到旧。
 *
 * 按工作区而不是按「在跑的提测」查：刚跑完的提测留下的流水也要能看到，
 * 否则页面会在提测结束的一瞬间把「为什么结束」的证据一起丢掉。
 */
export async function listPollEvents(
  workspaceId: string,
  limit = 30,
): Promise<BuildPollEventRow[]> {
  const rows = await prisma.buildPollEvent.findMany({
    where: { release: { project: { workspaceId } } },
    // 同一毫秒内可能写进多条，按主键再排一次，时间线才不会乱序。
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      createdAt: true,
      releaseId: true,
      snapshotId: true,
      packageName: true,
      event: true,
      condition: true,
      result: true,
      release: { select: { version: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    releaseId: row.releaseId,
    releaseVersion: row.release.version,
    snapshotId: row.snapshotId,
    packageName: row.packageName,
    event: row.event,
    condition: row.condition,
    result: row.result,
  }));
}
