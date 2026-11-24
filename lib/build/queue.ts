/**
 * 构建队列页与「构建状态」区块的读模型（A14）。
 *
 * 页面是**只读**的：数据全部来自库里，由 `runBuildPoll()` 的服务端轮询写进去。
 * 页面自己不调 CRP / Shuttle，也不用前端轮询去驱动状态写入（MUST NOT）。
 *
 * 这一层只做「把库里的行整理成页面要的形状」，判定口径与投递层共用：
 * 上游包名、阶段名都从 `lib/build` 里取，不在这里另写一套。
 */

import { prisma } from "../db";
import {
  listPollEvents,
  loadLatestDispatchFailures,
  type BuildPollEventRow,
  type DispatchFailureMarker,
} from "./pollEvent";
import { ACTIVE_RELEASE_STATES, loadUpstreamNames } from "./service";
import { queueStageOf, releaseStatusLabel, type StagePhase } from "./stage";

// ---------------------------------------------------------------------------
// 队列页
// ---------------------------------------------------------------------------

/** 一个软件包在队列里的样子。 */
export type QueueTaskRow = {
  releaseId: string;
  releaseVersion: string;
  snapshotId: string;
  packageName: string;
  /** 阶段分类，统计卡按它计数。 */
  phase: StagePhase;
  /** 阶段名，页面直接显示，例如「等待依赖」「构建中」。 */
  stage: string;
  /** 构建进度，例如「1/2 个架构完成」；还没开始构建时为空。 */
  progress: string | null;
  /** 同上进度的百分比（0–100，已完成的架构占比）；没有作业时为空。页面画进度条用它。 */
  progressPercent: number | null;
  /** 耗时（毫秒）：开始到现在，或开始到结束；还没开始时为空。 */
  durationMs: number | null;
  /** 还在等哪些上游包；不等依赖时为空数组。 */
  waitingFor: string[];
  /** 失败或阻断原因（来自构建任务）。 */
  reason: string | null;
  /**
   * 最近一次投递失败；这个包还在等投递时才有值。
   *
   * 投递成功之后快照不再是「待投递」，这里就是空：标记随状态收敛，不回头改历史流水。
   */
  dispatchFailure: DispatchFailureMarker | null;
};

/** 一条提测的队列视图：依赖拓扑 + 它下面每个包的进展。 */
export type QueueReleaseView = {
  releaseId: string;
  version: string;
  projectName: string;
  status: string;
  /** 提测状态的中文名。 */
  statusLabel: string;
  /** CRP 工作流进度；从没同步过时为空。 */
  workProgress: number | null;
  workProgressLabel: string | null;
  workProgressSyncedAt: Date | null;
  /** 依赖拓扑：`from` 是本提测内的上游包，`to` 是下游包。 */
  edges: Array<{ from: string; to: string }>;
  tasks: QueueTaskRow[];
};

/** 四张统计卡的数字。 */
export type BuildQueueStats = {
  /** 队列任务数：未完结提测里还没到终态的包数。 */
  queued: number;
  /** 构建中（含投递中）。 */
  building: number;
  /** 等待依赖：还没投出去，且在等上游。 */
  waiting: number;
  /** 今日完成：今天（UTC）拿到终态的构建任务数。 */
  finishedToday: number;
};

export type BuildQueueView = {
  stats: BuildQueueStats;
  releases: QueueReleaseView[];
  events: BuildPollEventRow[];
  /** 这批数字读出来的时刻，页面标一句「数据截至」。 */
  generatedAt: Date;
};

export type LoadBuildQueueOptions = {
  /** 注入用，测试固定「今天」。 */
  now?: Date;
};

/** 一个终态名字都没有的包，就算「还没做完」。 */
const OPEN_PHASES: ReadonlySet<StagePhase> = new Set<StagePhase>([
  "waiting",
  "queued",
  "running",
]);

/** 终态的构建状态：算进度时当已完成的架构。 */
const DONE_BUILD_STATES: ReadonlySet<string> = new Set(["success", "failed", "canceled"]);

/** UTC 当天零点。「今日完成」与页面显示的时间口径（全部按 UTC 展示）一致。 */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * 队列页取的那一版提测行。
 *
 * 取数与组装拆开之后，这份形状就是两者的接缝：`loadBuildQueueData()` 按它查库，
 * `buildQueueView()` 只按它组装、不再碰 Prisma。字段只留组装真正读的那些。
 */
type QueueReleaseSource = {
  id: string;
  version: string;
  status: string;
  crpWorkProgress: number | null;
  crpWorkProgressLabel: string | null;
  crpWorkProgressSyncedAt: Date | null;
  project: { name: string };
  snapshots: Array<{
    id: string;
    packageName: string;
    status: string;
    buildTask: {
      startedAt: Date | null;
      finishedAt: Date | null;
      blockedBySnapshotId: string | null;
      statusReason: string | null;
      jobs: Array<{ arch: string; status: string }>;
    } | null;
  }>;
};

/** 队列页的原始数据：库里的行 + 上游名单 + 今日计数 + 最近的流水。 */
export type BuildQueueSnapshot = {
  /** 未完结的提测，最新投递的在前。 */
  releases: readonly QueueReleaseSource[];
  /** 包名 → 上游包名，只含这批数据里出现过的名字。 */
  upstreams: ReadonlyMap<string, readonly string[]>;
  /** 今天（UTC）拿到终态的构建任务数。 */
  finishedToday: number;
  /** 最近的调度事件流水。 */
  events: BuildPollEventRow[];
  /** 快照 ID → 最近一次投递失败。没失败过的快照不在表里。 */
  dispatchFailures: ReadonlyMap<string, DispatchFailureMarker>;
  /** 这批数据读出来的时刻。 */
  generatedAt: Date;
};

/**
 * 取队列页要的数据，只查不组装。
 *
 * 只读**未完结**的提测：终局的提测留在「调度事件流水」与详情页里，不占队列页的位置。
 * 这个集合天然被「在跑的工作量」限住，所以**不加条数上限** —— 上限会把最新投递的提测挤掉
 * （QA 在功能检测里验出过：21 条活跃提测时新投递的那条看不到，统计卡也只算 20）。
 *
 * 排序按创建时间从新到旧：最新投递的排在最前，一打开页面就能看到自己刚起的提测。
 */
export async function loadBuildQueueData(
  workspaceId: string,
  options: LoadBuildQueueOptions = {},
): Promise<BuildQueueSnapshot> {
  const now = options.now ?? new Date();

  const releases = await prisma.release.findMany({
    where: { project: { workspaceId }, status: { in: [...ACTIVE_RELEASE_STATES] } },
    // 最新投递的排最前：不设条数上限，靠「只查未完结」自然收敛。
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      version: true,
      status: true,
      crpWorkProgress: true,
      crpWorkProgressLabel: true,
      crpWorkProgressSyncedAt: true,
      project: { select: { name: true } },
      // 只取当前轮：A17 会把旧轮标成 superseded，那些行不参与队列。
      snapshots: {
        where: { supersededById: null },
        orderBy: [{ packageName: "asc" }],
        select: {
          id: true,
          packageName: true,
          status: true,
          buildTask: {
            select: {
              startedAt: true,
              finishedAt: true,
              blockedBySnapshotId: true,
              statusReason: true,
              jobs: { select: { arch: true, status: true } },
            },
          },
        },
      },
    },
  });

  const upstreams = await loadUpstreamNames(
    releases.flatMap((release) => release.snapshots.map((snapshot) => snapshot.packageName)),
  );

  const [finishedToday, events, dispatchFailures] = await Promise.all([
    prisma.buildTask.count({
      where: {
        release: { project: { workspaceId } },
        finishedAt: { gte: startOfUtcDay(now) },
      },
    }),
    listPollEvents(workspaceId, 30),
    // 投递失败标记：只查这批快照，够用且不随全库流水增长。
    loadLatestDispatchFailures(
      releases.flatMap((release) => release.snapshots.map((snapshot) => snapshot.id)),
    ),
  ]);

  return {
    releases,
    upstreams,
    finishedToday,
    events,
    dispatchFailures,
    generatedAt: now,
  };
}

/**
 * 把一批原始数据组装成队列页的视图。
 *
 * 纯函数：不查库、不看时钟，输出只取决于传进来的数据 —— 所以同一份数据改动前后可以逐字段对比。
 * 统计卡与任务表出自同一批数据，不会出现「卡上一个数、表里另一个数」。
 */
export function buildQueueView(data: BuildQueueSnapshot): BuildQueueView {
  // 阻断原因指向的是同一提测里的兄弟快照，先把「ID → 包名」备好。
  const packageNameBySnapshotId = new Map(
    data.releases.flatMap((release) =>
      release.snapshots.map((snapshot) => [snapshot.id, snapshot.packageName] as const),
    ),
  );

  const views: QueueReleaseView[] = data.releases.map((release) => {
    const statusByName = new Map(
      release.snapshots.map((snapshot) => [snapshot.packageName, snapshot.status]),
    );
    const edges: Array<{ from: string; to: string }> = [];

    const tasks = release.snapshots.map((snapshot) => {
      const names = data.upstreams.get(snapshot.packageName) ?? [];
      const waitingFor = names.filter((name) => statusByName.get(name) !== "success");

      for (const name of names) {
        edges.push({ from: name, to: snapshot.packageName });
      }

      const blockedBySnapshotId = snapshot.buildTask?.blockedBySnapshotId ?? null;
      const stage = queueStageOf({
        snapshotStatus: snapshot.status,
        upstreamReady: waitingFor.length === 0,
        blockedBy:
          blockedBySnapshotId === null
            ? null
            : (packageNameBySnapshotId.get(blockedBySnapshotId) ?? "未知上游"),
      });

      return {
        releaseId: release.id,
        releaseVersion: release.version,
        snapshotId: snapshot.id,
        packageName: snapshot.packageName,
        phase: stage.phase,
        stage: stage.name,
        progress: describeProgress(snapshot.buildTask?.jobs ?? null),
        progressPercent: progressPercentOf(snapshot.buildTask?.jobs ?? null),
        durationMs: elapsedOf(snapshot.buildTask ?? null, data.generatedAt),
        waitingFor,
        reason: snapshot.buildTask?.statusReason ?? null,
        // 只给「还在等投递」的包挂标记：投递一成功，快照就离开 pending，标记随之消失（MUST）。
        dispatchFailure:
          snapshot.status === "pending"
            ? (data.dispatchFailures.get(snapshot.id) ?? null)
            : null,
      } satisfies QueueTaskRow;
    });

    return {
      releaseId: release.id,
      version: release.version,
      projectName: release.project.name,
      status: release.status,
      statusLabel: releaseStatusLabel(release.status),
      workProgress: release.crpWorkProgress,
      workProgressLabel: release.crpWorkProgressLabel,
      workProgressSyncedAt: release.crpWorkProgressSyncedAt,
      edges,
      tasks,
    } satisfies QueueReleaseView;
  });

  const allTasks = views.flatMap((view) => view.tasks);

  return {
    stats: {
      queued: allTasks.filter((task) => OPEN_PHASES.has(task.phase)).length,
      building: allTasks.filter((task) => task.phase === "running").length,
      waiting: allTasks.filter((task) => task.phase === "waiting").length,
      finishedToday: data.finishedToday,
    },
    releases: views,
    events: data.events,
    generatedAt: data.generatedAt,
  };
}

/**
 * 读一个工作区的构建队列：先取数，再组装。
 *
 * 页面、测试与之后的读模型都调这一个入口，拆开的两步只在需要单独对照时才直接用。
 */
export async function loadBuildQueue(
  workspaceId: string,
  options: LoadBuildQueueOptions = {},
): Promise<BuildQueueView> {
  return buildQueueView(await loadBuildQueueData(workspaceId, options));
}

// ---------------------------------------------------------------------------
// 提测详情页的构建状态区块
// ---------------------------------------------------------------------------

/** 一个架构的作业状态。 */
export type BuildArchView = { arch: string; status: string };

/** 一个包的构建状态。 */
export type BuildStatusTaskView = {
  snapshotId: string;
  packageName: string;
  /** 投给 CRP 的提测版本（CRP 的 Tag）。 */
  releaseVersion: string;
  /** 阶段名，与队列页同一套说法。 */
  stage: string;
  /** CRP 侧 Release ID；还没投递时为空。 */
  crpReleaseId: string | null;
  /** Shuttle 侧构建任务 ID；还没查到时为空。 */
  shuttleTaskId: string | null;
  /** 各架构的状态。只列状态，构建日志不在这里展开（给 ID 供跳转查）。 */
  arches: BuildArchView[];
  /** 耗时（毫秒）；还没开始构建时为空。 */
  durationMs: number | null;
  /** 最近一次轮询到这条构建的时间。 */
  lastPolledAt: Date | null;
  /** 失败或阻断原因。 */
  reason: string | null;
};

export type BuildStatusView = {
  releaseId: string;
  version: string;
  revision: number;
  status: string;
  statusLabel: string;
  crpTopicId: string | null;
  workProgress: number | null;
  workProgressLabel: string | null;
  workProgressSyncedAt: Date | null;
  tasks: BuildStatusTaskView[];
};

/**
 * 读一条提测的构建状态，给详情页的只读区块用。
 *
 * 提测不存在时返回 `null`：区块自己决定显示什么，不抛错也不 404 —— 它是详情页的一部分，
 * 「记录没了」该由详情页来说。
 */
export async function loadReleaseBuildStatus(
  releaseId: string,
  now: Date = new Date(),
): Promise<BuildStatusView | null> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      version: true,
      revision: true,
      status: true,
      crpTopicId: true,
      crpWorkProgress: true,
      crpWorkProgressLabel: true,
      crpWorkProgressSyncedAt: true,
      snapshots: {
        where: { supersededById: null },
        orderBy: [{ packageName: "asc" }],
        select: {
          id: true,
          packageName: true,
          status: true,
          releaseVersion: true,
          repositoryRecord: { select: { crpReleaseId: true } },
          buildTask: {
            select: {
              status: true,
              shuttleTaskId: true,
              startedAt: true,
              finishedAt: true,
              lastPolledAt: true,
              blockedBySnapshotId: true,
              statusReason: true,
              jobs: { select: { arch: true, status: true }, orderBy: { arch: "asc" } },
            },
          },
        },
      },
    },
  });

  if (release === null) {
    return null;
  }

  const upstreams = await loadUpstreamNames(
    release.snapshots.map((snapshot) => snapshot.packageName),
  );
  const statusByName = new Map(
    release.snapshots.map((snapshot) => [snapshot.packageName, snapshot.status]),
  );
  const packageNameBySnapshotId = new Map(
    release.snapshots.map((snapshot) => [snapshot.id, snapshot.packageName] as const),
  );

  return {
    releaseId: release.id,
    version: release.version,
    revision: release.revision,
    status: release.status,
    statusLabel: releaseStatusLabel(release.status),
    crpTopicId: release.crpTopicId,
    workProgress: release.crpWorkProgress,
    workProgressLabel: release.crpWorkProgressLabel,
    workProgressSyncedAt: release.crpWorkProgressSyncedAt,
    tasks: release.snapshots.map((snapshot) => {
      const blockedBySnapshotId = snapshot.buildTask?.blockedBySnapshotId ?? null;
      const waitingFor = (upstreams.get(snapshot.packageName) ?? []).filter(
        (name) => statusByName.get(name) !== "success",
      );

      return {
        snapshotId: snapshot.id,
        packageName: snapshot.packageName,
        releaseVersion: snapshot.releaseVersion,
        stage: queueStageOf({
          snapshotStatus: snapshot.status,
          upstreamReady: waitingFor.length === 0,
          blockedBy:
            blockedBySnapshotId === null
              ? null
              : (packageNameBySnapshotId.get(blockedBySnapshotId) ?? "未知上游"),
        }).name,
        crpReleaseId: snapshot.repositoryRecord?.crpReleaseId ?? null,
        shuttleTaskId: snapshot.buildTask?.shuttleTaskId ?? null,
        arches: (snapshot.buildTask?.jobs ?? []).map((job) => ({
          arch: job.arch,
          status: job.status,
        })),
        durationMs: elapsedOf(snapshot.buildTask ?? null, now),
        lastPolledAt: snapshot.buildTask?.lastPolledAt ?? null,
        reason: snapshot.buildTask?.statusReason ?? null,
      } satisfies BuildStatusTaskView;
    }),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type BuildTiming = { startedAt: Date | null; finishedAt: Date | null };

/**
 * 耗时：开始到结束；还在跑就算到此刻；还没开始就没有。
 *
 * 构建任务的 `startedAt` 只在第一次查到实际构建时才写，所以「已投递但还没开始构建」为空。
 */
function elapsedOf(build: BuildTiming | null, now: Date): number | null {
  if (build?.startedAt === null || build?.startedAt === undefined) {
    return null;
  }

  const end = build.finishedAt ?? now;

  return Math.max(0, end.getTime() - build.startedAt.getTime());
}

/** 作业完成情况：已完成的架构数 / 全部架构数；没有作业时为空。 */
function jobProgress(
  jobs: ReadonlyArray<{ status: string }> | null,
): { done: number; total: number } | null {
  if (jobs === null || jobs.length === 0) {
    return null;
  }

  return {
    done: jobs.filter((job) => DONE_BUILD_STATES.has(job.status)).length,
    total: jobs.length,
  };
}

/**
 * 构建进度：已完成的架构数 / 全部架构数。
 *
 * 任务有多个架构的作业，只说「构建中」看不出快好了还是刚开始，所以给个数。
 */
function describeProgress(
  jobs: ReadonlyArray<{ status: string }> | null,
): string | null {
  const progress = jobProgress(jobs);

  return progress === null ? null : `${progress.done}/${progress.total} 个架构完成`;
}

/**
 * 同一份进度的百分比（0–100，四舍五入到整数）。
 *
 * 页面要画进度条，但不能照抄原型里硬编码的 `68%` —— 用这里算出来的真实比例，
 * 也就不用写内联 `style`。还没开始构建（没有作业）时为空，页面就不画进度条。
 */
function progressPercentOf(
  jobs: ReadonlyArray<{ status: string }> | null,
): number | null {
  const progress = jobProgress(jobs);

  return progress === null ? null : Math.round((progress.done / progress.total) * 100);
}

/**
 * 耗时写成给人看的一句话。
 *
 * 构建动辄几十分钟，秒级精度没有意义，所以只到分钟：不足一分钟的给人「不到 1 分钟」。
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }

  const totalMinutes = Math.floor(durationMs / 60_000);

  if (totalMinutes < 1) {
    return "不到 1 分钟";
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours === 0 ? `${minutes} 分钟` : `${hours} 小时 ${minutes} 分钟`;
}
