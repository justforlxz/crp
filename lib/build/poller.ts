/**
 * 构建状态的定时轮询（A14）：把「谁在等谁」实时写进库里，页面只读库。
 *
 * 本仓库没有常驻调度进程，也不引入队列：外部定时器（cron / systemd timer）每 N 分钟
 * POST 一次 `/api/jobs/build-poll`；队列页的「手动刷新」调的是同一个 `runBuildPoll()`。
 * **MUST NOT 用前端轮询驱动状态写入**：页面永远是只读的，写入只发生在服务端这里。
 *
 * 一轮轮询对每条**未完结**的提测做三件事：
 *
 * 1. 复用 `pollReleaseBuilds` 把 Shuttle 的构建结果写回 `build_task` / `build_job`；
 * 2. 调 `getTopicWorkflow` 把 CRP 工作流进度写回 `release.crp_work_progress`
 *    —— 这是 A17 判断「还能不能改包」的唯一依据，所以每次轮询都要同步；
 * 3. 把这一轮做的事写进 `build_poll_event`（时间、软件包、事件、触发条件、结果）。
 *
 * 三条边界：
 *
 * - **已完结的提测不再轮询**（MUST）：只挑 `ACTIVE_RELEASE_STATES`，终局状态一条都不查、
 *   一条请求都不发；日志里能看出本轮只轮询了哪些提测。
 * - **活跃提测多于单轮上限时轮流轮到**：单轮最多处理 `limit` 条（默认 50），挑活按
 *   `release.last_polled_at` 从旧到新（为空的最先），所以最新投递的提测下一轮就会被轮到，
 *   不会出现「创建最早的永远排前、后来的永远轮不到」。
 * - **轮询失败不改状态**（MUST）：任何异常只记事件与日志，`release.status` 与
 *   `build_task.status` 保持原样 —— 查不到不等于构建失败。
 * - **取不到工作流进度时保留旧值并记同步错误，绝不写 0**（MUST）：CRP 对还没走过工作流的
 *   Topic 会回一个全零对象，把它当 0 写进去会让 A17 误以为这条提测还在「未开始」。
 */

import { prisma } from "../db";
import { workProgressLabel } from "../integrations/crp";
import { prunePollEvents, recordPollEvent } from "./pollEvent";
import {
  ACTIVE_RELEASE_STATES,
  pollReleaseBuilds,
  resolveClients,
  type BuildNetwork,
  type PollSummary,
} from "./service";
import { snapshotStatusLabel } from "./stage";

/** 一轮轮询由谁触发。与同步任务的 `manual` / `schedule` 同一套说法。 */
export type BuildPollTrigger = "manual" | "schedule";

/** 一轮轮询里单条提测的结果。接口直接把它返回给调用方。 */
export type BuildPollItem = {
  releaseId: string;
  version: string;
  /** 提测状态。轮询不改它，出错时也还是推进前的那个值。 */
  status: string;
  /** 在 CRP 侧查到的已投递包数。 */
  checked: number;
  succeeded: string[];
  failed: string[];
  building: string[];
  /** 本轮写回的 CRP 工作流进度；没有 Topic 或取不到时为 `null`（库里保留上一次的值）。 */
  workProgress: number | null;
  workProgressLabel: string | null;
  /** 本轮的错误摘要。有值时上面那些状态一个都没被改。 */
  error: string | null;
};

export type BuildPollSummary = {
  trigger: BuildPollTrigger;
  /** 本轮参与轮询的提测条数（已完结的不算）。 */
  releaseCount: number;
  /** 本轮轮询成功的条数。 */
  polled: number;
  /** 本轮出错的条数。 */
  failed: number;
  items: BuildPollItem[];
};

export type BuildPollOptions = {
  trigger: BuildPollTrigger;
  /** 注入用，测试替换网络实现。 */
  network?: BuildNetwork;
  /** 单轮最多轮询多少条提测，防止一次拉太多把请求拖过超时。 */
  limit?: number;
};

/** 单轮默认最多轮询多少条提测。 */
const DEFAULT_LIMIT = 50;

/** 轮询这一轮的触发条件，写进事件流水的 `condition`。 */
const TRIGGER_CONDITION: Record<BuildPollTrigger, string> = {
  manual: "手动刷新",
  schedule: "周期到期",
};

/**
 * 新建 Topic 的头几轮 CRP 还没算出工作流进度，`workflow/info` 回全零对象。
 *
 * 这时轮询这一条会报失败、但不改任何字段（见本文件 `pickWorkflowProgress` 的使用处）。
 * 它不是「提测出错」，演练脚本要等下一轮继续，不能拿它判失败 —— 所以这条文案常量对外导出，
 * 免得调用方再抄一遍字符串。
 */
export const WORKFLOW_PROGRESS_PENDING_MESSAGE =
  "CRP 返回的工作流信息里没有可用的进度（全零对象）";

/** 错误摘要：只留人看得懂的一句，不存整段堆栈。 */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return message.slice(0, 500);
}

/**
 * `getTopicWorkflow` 的原始响应。
 *
 * 只声明我们真正读的两个字段，并且都是 `unknown`：`CrpRawWorkflowInfo` 把 `WorkProgress`
 * 声明成可选的 `number`，但真实响应里可能是 `null`、空串甚至别的东西，不能按类型声明当真。
 */
export type WorkflowRaw = {
  TopicID?: unknown;
  WorkProgress?: unknown;
};

/**
 * 把上游给的值转成有限数字；`null`、空串、布尔、非数字一律算「没给」。
 *
 * 不能直接 `Number(...)`：`Number(null)` 与 `Number("")` 都是 0，会把「CRP 什么都没给」
 * 当成「进度回到了未开始」，正好撞上 MUST「不得写 0」。
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * 从 `getTopicWorkflow` 的原始响应里取出可用的进度；取不到返回 `null`。
 *
 * 必须看原始响应而不是 `workProgress` 字段：`normalizeTopicWorkflow` 把缺字段的响应
 * 补成 0，调用方没法区分「真的一步没走」与「CRP 什么都没给」。
 *
 * 判定规则：
 *
 * - `WorkProgress` 缺字段、为 `null`、为空串或不是数字 → 取不到（`null` 不能当 0）；
 * - `WorkProgress` 是 0 **且** `TopicID` 不是有效主题号 → 这是还没走过工作流时的全零占位对象，取不到；
 * - 其余情况（含「TopicID 正常、进度真的是 0」）→ 用这个数值。
 */
export function pickWorkflowProgress(
  raw: WorkflowRaw | null | undefined,
): { workProgress: number; workProgressLabel: string } | null {
  const value = toFiniteNumber(raw?.WorkProgress);

  if (value === null) {
    return null;
  }

  const topicId = toFiniteNumber(raw?.TopicID);
  const knownTopic = topicId !== null && topicId > 0;

  if (value === 0 && !knownTopic) {
    return null;
  }

  return { workProgress: value, workProgressLabel: workProgressLabel(value) };
}

/** 工作流进度同步的三种结局。 */
type WorkProgressResult =
  | { status: "skipped" }
  | { status: "synced"; workProgress: number; workProgressLabel: string }
  | { status: "failed"; error: string; previous: number | null };

type PollTarget = {
  id: string;
  version: string;
  status: string;
  crpTopicId: string | null;
  crpWorkProgress: number | null;
};

/**
 * 同步一条提测的工作流进度。
 *
 * 失败（网络错误、认证失败、CRP 回了全零对象、Topic ID 不是数字）时**不写任何字段**，
 * 只把原因交回调用方：旧值比 0 有用得多，写 0 会让 A17 误判成「还没转测，可以随便改」。
 */
async function syncWorkProgress(
  release: PollTarget,
  options: BuildPollOptions,
): Promise<WorkProgressResult> {
  if (release.crpTopicId === null) {
    // 还没建 Topic，工作流无从谈起；这不是错误，也不该写 0。
    return { status: "skipped" };
  }

  const topicId = Number(release.crpTopicId);

  if (!Number.isInteger(topicId) || topicId <= 0) {
    return {
      status: "failed",
      error: `CRP Topic ID 不是数字：${release.crpTopicId}`,
      previous: release.crpWorkProgress,
    };
  }

  const { clients } = resolveClients(release.id, { network: options.network });

  try {
    const workflow = await clients.crp.getTopicWorkflow(topicId);
    const picked = pickWorkflowProgress(workflow.raw);

    if (picked === null) {
      return {
        status: "failed",
        error: WORKFLOW_PROGRESS_PENDING_MESSAGE,
        previous: release.crpWorkProgress,
      };
    }

    await prisma.release.update({
      where: { id: release.id },
      data: {
        crpWorkProgress: picked.workProgress,
        crpWorkProgressLabel: picked.workProgressLabel,
        crpWorkProgressSyncedAt: new Date(),
      },
    });

    return { status: "synced", ...picked };
  } catch (error) {
    return { status: "failed", error: errorSummary(error), previous: release.crpWorkProgress };
  }
}

/** 当前轮快照的状态与阻断来源。用来比对「这一轮谁的状态变了」。 */
type SnapshotState = {
  snapshotId: string;
  packageName: string;
  status: string;
  blockedByPackageName: string | null;
};

/**
 * 读一条提测当前轮快照的状态。
 *
 * `blockedBySnapshotId` 是快照 ID，页面与流水要的是包名，所以顺手换成名字。
 */
async function loadSnapshotStates(releaseId: string): Promise<SnapshotState[]> {
  const rows = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId, supersededById: null },
    orderBy: [{ packageName: "asc" }],
    select: {
      id: true,
      packageName: true,
      status: true,
      buildTask: { select: { blockedBySnapshotId: true } },
    },
  });

  const blockedIds = [
    ...new Set(
      rows
        .map((row) => row.buildTask?.blockedBySnapshotId ?? null)
        .filter((id): id is string => id !== null),
    ),
  ];

  const blocked =
    blockedIds.length === 0
      ? []
      : await prisma.releasePackageSnapshot.findMany({
          where: { id: { in: blockedIds } },
          select: { id: true, packageName: true },
        });

  const nameById = new Map(blocked.map((row) => [row.id, row.packageName]));

  return rows.map((row) => ({
    snapshotId: row.id,
    packageName: row.packageName,
    status: row.status,
    blockedByPackageName:
      row.buildTask?.blockedBySnapshotId === null || row.buildTask?.blockedBySnapshotId === undefined
        ? null
        : (nameById.get(row.buildTask.blockedBySnapshotId) ?? "未知上游"),
  }));
}

/**
 * 把一轮轮询的结果写进事件流水。
 *
 * 只写「真变了」的状态：轮询是反复跑的，每次都写一条会把流水刷满，
 * 而流水要回答的是「谁在什么时候从哪一步走到哪一步」。
 */
async function recordStatusChanges(
  release: PollTarget,
  before: readonly SnapshotState[],
  after: readonly SnapshotState[],
): Promise<void> {
  const beforeById = new Map(before.map((item) => [item.snapshotId, item]));

  for (const item of after) {
    const previous = beforeById.get(item.snapshotId);

    if (previous === undefined || previous.status === item.status) {
      continue;
    }

    const blocked = item.blockedByPackageName === null ? "" : `（上游 ${item.blockedByPackageName} 失败）`;

    await recordPollEvent({
      releaseId: release.id,
      snapshotId: item.snapshotId,
      packageName: item.packageName,
      event: "status",
      condition: "轮询取到 Shuttle 的构建结论",
      result: `${snapshotStatusLabel(previous.status)} → ${snapshotStatusLabel(item.status)}${blocked}`,
    });
  }
}

/** 轮询一条提测：构建结果 + 工作流进度 + 事件流水。 */
async function pollOne(
  release: PollTarget,
  options: BuildPollOptions,
): Promise<BuildPollItem> {
  const condition = TRIGGER_CONDITION[options.trigger];
  const before = await loadSnapshotStates(release.id);

  let polled: PollSummary | null = null;
  let pollError: string | null = null;

  try {
    polled = await pollReleaseBuilds(release.id, { network: options.network });
  } catch (error) {
    pollError = errorSummary(error);
  }

  // 轮询抛错时也读一次：出错前它可能已经回写成功了一部分包的状态，
  // 这些变化照样要进流水，否则页面上会留下一段没有记载的状态跳变。
  const after = await loadSnapshotStates(release.id);

  await recordStatusChanges(release, before, after);

  const progress = await syncWorkProgress(release, options);

  await recordProgressEvent(release.id, progress);
  await recordPollEvent({
    releaseId: release.id,
    event: "poll",
    condition,
    result:
      pollError === null
        ? describePoll(polled)
        : `失败：${pollError}；构建状态保持原样，等下一轮再查`,
  });

  const error =
    pollError ?? (progress.status === "failed" ? progress.error : null);

  // 记「这一轮看过它了」，轮询挑活按这一列从旧到新轮转。
  // 失败也照写：不写的话一条一直失败的提测会永远占住队首，把别的提测饿死。
  await prisma.release.update({ where: { id: release.id }, data: { lastPolledAt: new Date() } });

  return {
    releaseId: release.id,
    version: release.version,
    status: release.status,
    checked: polled?.checked ?? 0,
    succeeded: polled?.succeeded ?? [],
    failed: polled?.failed ?? [],
    building: polled?.building ?? [],
    workProgress: progress.status === "synced" ? progress.workProgress : null,
    workProgressLabel: progress.status === "synced" ? progress.workProgressLabel : null,
    error,
  };
}

/**
 * 轮询一条提测，并且不让它把整轮拖垮。
 *
 * `pollOne` 只兜住 CRP / Shuttle 的错；读库、写库出错会抛出来。这类错误只影响这一条，
 * 记进本轮结果，下一轮按轮转还会再轮到它。
 */
async function pollOneSafely(
  release: PollTarget,
  options: BuildPollOptions,
): Promise<BuildPollItem> {
  try {
    return await pollOne(release, options);
  } catch (error) {
    // 与 `pollOne` 末尾写的是同一列：失败也记「这一轮看过它了」，两条路径才对得上。
    // 写不进去就算了 —— 这条本来已经是失败记录，不能再让它把整轮拖垮。
    await prisma.release
      .update({ where: { id: release.id }, data: { lastPolledAt: new Date() } })
      .catch((updateError: unknown) => {
        console.error(`[build-poll] 提测 ${release.id} 的轮询时间写不进去：`, updateError);
      });

    return {
      releaseId: release.id,
      version: release.version,
      status: release.status,
      checked: 0,
      succeeded: [],
      failed: [],
      building: [],
      workProgress: null,
      workProgressLabel: null,
      error: errorSummary(error),
    };
  }
}

/** 一次轮询的成果写成一句人话。 */
function describePoll(polled: PollSummary | null): string {
  if (polled === null || polled.checked === 0) {
    return "查询 0 个包：还没有包投递到 CRP";
  }

  return (
    `查询 ${polled.checked} 个包：成功 ${polled.succeeded.length}` +
    `、失败 ${polled.failed.length}、构建中 ${polled.building.length}`
  );
}

/** 工作流进度的回写结果进流水；没建 Topic 的提测不写，免得流水里全是「跳过」。 */
async function recordProgressEvent(
  releaseId: string,
  progress: WorkProgressResult,
): Promise<void> {
  if (progress.status === "skipped") {
    return;
  }

  const result =
    progress.status === "synced"
      ? `${progress.workProgress} ${progress.workProgressLabel}`
      : `失败：${progress.error}；保留上一次的值 ${progress.previous === null ? "（无）" : progress.previous}`;

  await recordPollEvent({
    releaseId,
    event: "progress",
    condition: "CRP 工作流进度随轮询同步（A17 判断能否改包的唯一依据）",
    result,
  });
}

/**
 * 把当前未完结的提测各轮询一遍。
 *
 * 挑活只看状态：`pending`（还没建 Topic）、`dispatching`（正在逐个投递）、`building`
 * （已投完等结果）。终局状态（`success` / `partial_failure` / `failed` / `abandoned`）
 * 一条都不查 —— 这就是「已完结的提测自动停止轮询」。
 *
 * 单轮最多处理 `limit` 条，挑活按「最久没被轮询的优先」（`last_polled_at` 从旧到新，为空的最先）：
 * 活跃提测多于上限时各条轮流轮到，最新投递的下一条就是它。**不要改回按创建时间取最早的 N 条** ——
 * 那样最新投递的提测永远排在后面，永远轮不到（QA 在功能检测里验出过）。
 *
 * 单条提测出错不中断整轮：CRP 偶尔超时、数据库偶发拒绝都是常态，一条失败不该让别的提测跟着停下。
 */
export async function runBuildPoll(
  options: BuildPollOptions,
): Promise<BuildPollSummary> {
  const releases = await prisma.release.findMany({
    where: { status: { in: [...ACTIVE_RELEASE_STATES] } },
    orderBy: [
      // 为空表示从没被轮询过，排最前。
      { lastPolledAt: { sort: "asc", nulls: "first" } },
      // 同一时刻入队的按创建时间、再按主键定序，保证每一轮挑出来的名单稳定可复现。
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: options.limit ?? DEFAULT_LIMIT,
    select: {
      id: true,
      version: true,
      status: true,
      crpTopicId: true,
      crpWorkProgress: true,
    },
  });

  const summary: BuildPollSummary = {
    trigger: options.trigger,
    releaseCount: releases.length,
    polled: 0,
    failed: 0,
    items: [],
  };

  for (const release of releases) {
    const item = await pollOneSafely(release, options);

    if (item.error === null) {
      summary.polled += 1;
    } else {
      summary.failed += 1;
      console.warn(`[build-poll] 提测 ${release.id} 轮询失败：${item.error}`);
    }

    summary.items.push(item);
  }

  console.info(
    `[build-poll] 触发=${options.trigger} 轮询=${summary.releaseCount} 条` +
      `（只轮询 ${ACTIVE_RELEASE_STATES.join("/")}，已完结的提测不再轮询）` +
      ` 成功=${summary.polled} 失败=${summary.failed}`,
  );
  // 流水只追加，靠这一轮顺手清掉过期的行，否则它会随轮询轮次一直长。
  // 放在最后：清理失败不影响本轮已经写好的状态与结果。
  await prunePollEvents();

  return summary;
}
