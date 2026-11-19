/**
 * 工作台（A15）：一屏回答「这周提测多少、卡在哪、哪个项目没配好」。
 *
 * 只做读模型：四张统计卡的数字全部由数据库聚合查询得出（`count` / `groupBy`），
 * 页面只负责排版，不自己数行、不在前端拼算。切工作区后 `workspaceId` 变，全部查询跟着变，
 * 因此「数字随之变化、且只统计该工作区」由这一层的 `where` 保证，不靠页面过滤。
 *
 * 复用的现成能力（不另写一套）：
 *
 * | 要的东西 | 来源 |
 * | --- | --- |
 * | 构建队列摘要与队列统计 | `lib/build` 的 `loadBuildQueue` |
 * | 依赖环检测与展示 | `lib/packages` 的 `findDependencyCycle`、`formatCycle` |
 * | 提测状态 / 来源的中文名 | `lib/releases` 的 `releaseStatusLabel`、`releaseSourceLabel` |
 * | 「本周」「成功率」的口径 | `./period` |
 *
 * 不建宽表、不建缓存表（MUST NOT）：每次进页面现算，数据量由「未完结提测」与
 * 「最近 7 天」两个条件自然收敛。
 */

import { ACTIVE_RELEASE_STATES, loadBuildQueue } from "../build";
import { prisma } from "../db";
import { findDependencyCycle, formatCycle, type DependencyEdge } from "../packages";
import { releaseSourceLabel, releaseStatusLabel } from "../releases";
import {
  recentWindowStart,
  SETTLED_RELEASE_STATUSES,
  successRatePercent,
  STATS_WINDOW_DAYS,
} from "./period";

/** 四张统计卡。 */
export type DashboardCards = {
  /** 「本周提测次数」：最近 7 天创建的提测数，全部状态都算。 */
  weekReleaseCount: number;
  /**
   * 「等待构建数」：已投给 CRP、还没开始构建的包（`build_task.status = pending`）。
   *
   * 只算当前轮快照、且提测未完结的那些：被 A17 换掉的旧轮、被取消的提测都会留下
   * 永远不会被推进的残留任务，它们不算「在等构建」。
   */
  waitingBuildCount: number;
  /** 「本周成功率」：最近 7 天已有结论的提测里成功的占比。 */
  weekSuccessRate: {
    /** 整数百分比；一条结论都没有时为空，页面显示「—」。 */
    percent: number | null;
    success: number;
    settled: number;
  };
  /** 「项目配置数」：未软删的项目数。 */
  projectCount: number;
};

/** 最近提测表的一行。 */
export type RecentReleaseRow = {
  id: string;
  version: string;
  /** 状态中文名，与提测记录列表同一套说法。 */
  statusLabel: string;
  /** 来源中文名：平台创建 / 从 CRP 导入。 */
  sourceLabel: string;
  projectName: string;
  projectKey: string;
  createdAt: Date;
};

/** 构建队列摘要的一行：一个包的排队情况。 */
export type QueueSummaryRow = {
  snapshotId: string;
  releaseId: string;
  /** 提测版本，与项目名一起标识这条提测。 */
  releaseVersion: string;
  projectName: string;
  packageName: string;
  /** 阶段名，例如「等待依赖」「构建中」。 */
  stage: string;
  /** 构建进度，例如「1/2 个架构完成」；还没开始构建时为空。 */
  progress: string | null;
  /** 耗时（毫秒），页面用 `formatDuration` 显示。 */
  durationMs: number | null;
};

/** 项目提测概况的一行。 */
export type ProjectOverviewRow = {
  id: string;
  key: string;
  name: string;
  /** 最近 7 天的提测数。 */
  weekReleaseCount: number;
  /** 最近一次提测的版本；从没提测过时为空。 */
  latestVersion: string | null;
  /** 最近一次提测的状态中文名；从没提测过时为空。 */
  latestStatusLabel: string | null;
  latestAt: Date | null;
};

/** 配置待办：两类需要在项目上补配置的问题。 */
export type ConfigTodo = {
  /** 没配软件清单的项目：清单为空时创建提测会被阻断。 */
  missingSoftware: Array<{ id: string; key: string; name: string }>;
  /** 清单内依赖有环的项目：环上的包名首尾同名，例如 `A → B → A`。 */
  dependencyCycles: Array<{ id: string; key: string; name: string; cycle: string }>;
};

export type DashboardView = {
  cards: DashboardCards;
  /** 最近提测（按创建时间倒序，最多 5 条）。 */
  recentReleases: RecentReleaseRow[];
  /** 构建队列摘要（前 5 条任务）。 */
  queueTasks: QueueSummaryRow[];
  /** 每个项目的提测概况，按项目名排。 */
  projects: ProjectOverviewRow[];
  configTodo: ConfigTodo;
  /** 这批数字读出来的时刻，页面标一句「数据截至」。 */
  generatedAt: Date;
};

export type LoadDashboardOptions = {
  /** 注入用，测试固定「本周」的参照时刻。 */
  now?: Date;
};

/** 最近提测表与构建队列摘要各显示几条。 */
const RECENT_LIMIT = 5;
const QUEUE_SUMMARY_LIMIT = 5;

/**
 * 读一个工作区的工作台数据。
 *
 * 八次查询全部按 `workspaceId` 收窄，且互相独立，并发发出。
 */
export async function loadDashboard(
  workspaceId: string,
  options: LoadDashboardOptions = {},
): Promise<DashboardView> {
  const now = options.now ?? new Date();
  const windowStart = recentWindowStart(now, STATS_WINDOW_DAYS);

  const [weekStatusRows, waitingBuildCount, projectCount, recentReleases, queue, projectRows] =
    await Promise.all([
      // 一次 groupBy 拿到本周全部状态的分组数，本周提测数、成功数、已结论数都从它算。
      prisma.release.groupBy({
        by: ["status"],
        where: { project: { workspaceId }, createdAt: { gte: windowStart } },
        _count: { _all: true },
      }),
      // 只算「当前这一轮、且提测还没完结」的待开始任务：
      // A17 换包只把旧轮快照标 superseded，旧轮的构建任务会停在 pending（`lib/releases/update.ts`
      // 的 `supersedeOldRounds` 不碰 build_task）；取消提测也只改快照与提测状态
      // （`cancelRelease` 同样不碰 build_task）。这两类残留任务永远不会被轮询推进，
      // 不排除就会让卡片数字永久偏大，与「已投给 CRP、还没开始构建的包」这句话对不上。
      prisma.buildTask.count({
        where: {
          status: "pending",
          snapshot: { supersededById: null },
          release: {
            project: { workspaceId },
            status: { in: [...ACTIVE_RELEASE_STATES] },
          },
        },
      }),
      prisma.project.count({ where: { workspaceId, deletedAt: null } }),
      prisma.release.findMany({
        where: { project: { workspaceId } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RECENT_LIMIT,
        select: {
          id: true,
          version: true,
          status: true,
          source: true,
          createdAt: true,
          project: { select: { key: true, name: true } },
        },
      }),
      loadBuildQueue(workspaceId, { now }),
      prisma.project.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: { name: "asc" },
        select: {
          id: true,
          key: true,
          name: true,
          software: {
            select: {
              package: {
                select: {
                  name: true,
                  dependencies: { select: { upstreamPackage: { select: { name: true } } } },
                },
              },
            },
          },
        },
      }),
    ]);

  const projectIds = projectRows.map((project) => project.id);

  const [weekCountRows, latestRows] = await Promise.all([
    projectIds.length === 0
      ? []
      : prisma.release.groupBy({
          by: ["projectId"],
          where: { projectId: { in: projectIds }, createdAt: { gte: windowStart } },
          _count: { _all: true },
        }),
    projectIds.length === 0
      ? []
      : prisma.release.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: [{ projectId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          // 每个项目只留创建时间最新的那一条；排序已保证第一条就是最新的。
          distinct: ["projectId"],
          select: { projectId: true, version: true, status: true, createdAt: true },
        }),
  ]);

  const weekCountByProject = new Map(
    weekCountRows.map((row) => [row.projectId, row._count._all] as const),
  );
  const latestByProject = new Map(
    latestRows.map(
      (row) => [row.projectId, { version: row.version, status: row.status, at: row.createdAt }] as const,
    ),
  );

  const countOf = (predicate: (status: string) => boolean): number =>
    weekStatusRows.reduce(
      (sum, row) => (predicate(row.status) ? sum + row._count._all : sum),
      0,
    );

  const weekSuccessCount = countOf((status) => status === "success");
  const weekSettledCount = countOf((status) => SETTLED_RELEASE_STATUSES.includes(status));

  return {
    cards: {
      weekReleaseCount: countOf(() => true),
      waitingBuildCount,
      weekSuccessRate: {
        percent: successRatePercent(weekSuccessCount, weekSettledCount),
        success: weekSuccessCount,
        settled: weekSettledCount,
      },
      projectCount,
    },
    recentReleases: recentReleases.map((release) => ({
      id: release.id,
      version: release.version,
      statusLabel: releaseStatusLabel(release.status),
      sourceLabel: releaseSourceLabel(release.source),
      projectName: release.project.name,
      projectKey: release.project.key,
      createdAt: release.createdAt,
    })),
    queueTasks: queue.releases
      .flatMap((release) =>
        release.tasks.map((task) => ({
          snapshotId: task.snapshotId,
          releaseId: release.releaseId,
          releaseVersion: release.version,
          projectName: release.projectName,
          packageName: task.packageName,
          stage: task.stage,
          progress: task.progress,
          durationMs: task.durationMs,
        })),
      )
      .slice(0, QUEUE_SUMMARY_LIMIT),
    projects: projectRows.map((project) => {
      const latest = latestByProject.get(project.id) ?? null;

      return {
        id: project.id,
        key: project.key,
        name: project.name,
        weekReleaseCount: weekCountByProject.get(project.id) ?? 0,
        latestVersion: latest?.version ?? null,
        latestStatusLabel: latest === null ? null : releaseStatusLabel(latest.status),
        latestAt: latest?.at ?? null,
      };
    }),
    configTodo: {
      missingSoftware: projectRows
        .filter((project) => project.software.length === 0)
        .map(({ id, key, name }) => ({ id, key, name })),
      dependencyCycles: projectRows.flatMap((project) => {
        const cycle = projectCycle(project.software);

        return cycle === null ? [] : [{ id: project.id, key: project.key, name: project.name, cycle }];
      }),
    },
    generatedAt: now,
  };
}

type SoftwareRow = {
  package: {
    name: string;
    dependencies: ReadonlyArray<{ upstreamPackage: { name: string } }>;
  };
};

/**
 * 一个项目软件清单里的第一条依赖环。
 *
 * 只看清单内部的边：清单外的上游不参与这次提测，构不成先后关系，这与项目卡片的
 * `buildSoftwareView` 是同一个口径（同一份清单在两处不能一个有环、一个没环）。
 * 检测本身用 `lib/packages` 的 `findDependencyCycle`，不在这里另写一套。
 */
function projectCycle(software: readonly SoftwareRow[]): string | null {
  const inside = new Set(software.map((item) => item.package.name));
  const edges: DependencyEdge[] = [];

  for (const item of software) {
    for (const dependency of item.package.dependencies) {
      const upstream = dependency.upstreamPackage.name;

      if (inside.has(upstream)) {
        edges.push({ from: item.package.name, to: upstream });
      }
    }
  }

  const cycle = findDependencyCycle(edges);

  return cycle === null ? null : formatCycle(cycle);
}
