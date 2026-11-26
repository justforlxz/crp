/**
 * 工作台（A15 + 界面规范 v2）：一屏回答「有多少条在跑、卡在哪、哪个项目没配好」。
 *
 * 只做读模型：四张统计卡的数字全部由一次 `groupBy` 得出，页面只负责排版，不自己数行、
 * 不在前端拼算。切工作区后 `workspaceId` 变，全部查询跟着变，因此「数字随之变化、且只统计
 * 该工作区」由这一层的 `where` 保证，不靠页面过滤。
 *
 * 四张卡的口径照 `design.md` 与原型：**按提测状态计，不按软件包计，不设时间窗**。
 * 「进行中」不含「待投递」—— 待投递单独一张卡，两者相加才是全部未完结的提测。
 *
 * | 卡片 | 状态 |
 * | --- | --- |
 * | 进行中的提测 | `dispatching`、`building` |
 * | 构建成功 | `success` |
 * | 构建失败 | `failed`、`partial_failure` |
 * | 等待投递 | `pending` |
 *
 * 复用的现成能力（不另写一套）：
 *
 * | 要的东西 | 来源 |
 * | --- | --- |
 * | 构建队列摘要与队列统计 | `lib/build` 的 `loadBuildQueue` |
 * | 依赖环检测与展示 | `lib/packages` 的 `findDependencyCycle`、`formatCycle` |
 * | 提测状态 / 来源的中文名与状态点档位 | `lib/releases` 的 `releaseStatusLabel`、`releaseStatusTone`、`releaseSourceLabel` |
 *
 * 不建宽表、不建缓存表（MUST NOT）：每次进页面现算，数据量由「未完结提测」与「最近 5 条」自然收敛。
 */

import { loadBuildQueue, type QueueTaskRow } from "../build";
import { prisma } from "../db";
import { findDependencyCycle, formatCycle, type DependencyEdge } from "../packages";
import { releaseSourceLabel, releaseStatusLabel, releaseStatusTone } from "../releases";


/** 四张统计卡。 */
export type DashboardCards = {
  /** 「进行中的提测」：正在投递或构建中（不含待投递）。 */
  inProgressReleases: number;
  /** 「构建成功」：状态为 `success` 的提测数。 */
  succeededReleases: number;
  /** 「构建失败」：状态为 `failed` 或 `partial_failure` 的提测数。 */
  failedReleases: number;
  /** 「等待投递」：已创建、还没投给 CRP 的提测数。 */
  waitingReleases: number;
};

/** 最近提测表的一行。 */
export type RecentReleaseRow = {
  id: string;
  version: string;
  /** 状态码，页面按它选状态点的档位。 */
  status: string;
  /** 状态中文名，与提测记录列表同一套说法。 */
  statusLabel: string;
  /** 状态点档位（`.is-ok` 这类），与列表页同一份判定。 */
  statusTone: string;
  /** 来源中文名：平台创建 / 从 CRP 导入。 */
  sourceLabel: string;
  projectName: string;
  projectKey: string;
  /** 当前这一轮的软件包数。 */
  packageCount: number;
  createdAt: Date;
};

/**
 * 构建队列摘要的一行：一个包的排队情况。
 *
 * 就是队列页那一行的全部字段（`QueueTaskRow`）再加一个项目名 —— 工作台只列几条，
 * 不显示依赖拓扑，但点开作业详情弹窗要看的东西（架构、Topic、耗时、阻断原因）一个都不少，
 * 所以两页交给同一个组件，形状也就不能各写一份。
 */
export type QueueSummaryRow = QueueTaskRow & { projectName: string };

/**
 * 项目提测概况的一行。
 *
 * 列与原型一致：项目 / 项目经理 / 软件包 / 依赖 / 最近提测。前四列是项目配置的事实，
 * 最后一列是「这个项目最近一次提测是什么、什么时候」。
 */
export type ProjectOverviewRow = {
  id: string;
  key: string;
  name: string;
  /** 负责这个项目的项目经理名。 */
  managerName: string;
  /** 清单里的软件包数。 */
  packageCount: number;
  /** 清单内部的依赖边数（清单外的上游不参与这次提测，不计）。 */
  dependencyCount: number;
  /** 最近一次提测的版本；从没提测过时为空。 */
  latestVersion: string | null;
  /** 最近一次提测的状态码；从没提测过时为空。 */
  latestStatus: string | null;
  /** 最近一次提测的状态中文名；从没提测过时为空。 */
  latestStatusLabel: string | null;
  /** 最近一次提测的状态点档位；从没提测过时为空。 */
  latestStatusTone: string | null;
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
  /** 注入用，测试固定队列摘要的参照时刻。 */
  now?: Date;
};

/** 最近提测表与构建队列摘要各显示几条。 */
const RECENT_LIMIT = 5;
const QUEUE_SUMMARY_LIMIT = 5;

/**
 * 读一个工作区的工作台数据。
 *
 * 各次查询全部按 `workspaceId` 收窄，且互相独立，并发发出。
 */
export async function loadDashboard(
  workspaceId: string,
  options: LoadDashboardOptions = {},
): Promise<DashboardView> {
  const now = options.now ?? new Date();

  const [statusRows, recentReleases, queue, projectRows] = await Promise.all([
    // 一次 groupBy 拿到全部状态的分组数，四张卡都从它算。
    prisma.release.groupBy({
      by: ["status"],
      where: { project: { workspaceId } },
      _count: { _all: true },
    }),
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
        projectManager: { select: { name: true } },
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

  const [latestRows, packageCountRows] = await Promise.all([
    projectIds.length === 0
      ? []
      : prisma.release.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: [{ projectId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          // 每个项目只留创建时间最新的那一条；排序已保证第一条就是最新的。
          distinct: ["projectId"],
          select: { projectId: true, version: true, status: true, createdAt: true },
        }),
    recentReleases.length === 0
      ? []
      : prisma.releasePackageSnapshot.groupBy({
          by: ["releaseId"],
          where: { releaseId: { in: recentReleases.map((release) => release.id) }, supersededById: null },
          _count: { _all: true },
        }),
  ]);

  const latestByProject = new Map(
    latestRows.map(
      (row) => [row.projectId, { version: row.version, status: row.status, at: row.createdAt }] as const,
    ),
  );
  const packageCountByRelease = new Map(
    packageCountRows.map((row) => [row.releaseId, row._count._all] as const),
  );

  const countOf = (predicate: (status: string) => boolean): number =>
    statusRows.reduce(
      (sum, row) => (predicate(row.status) ? sum + row._count._all : sum),
      0,
    );

  return {
    cards: {
      inProgressReleases: countOf((status) => status === "dispatching" || status === "building"),
      succeededReleases: countOf((status) => status === "success"),
      failedReleases: countOf((status) => status === "failed" || status === "partial_failure"),
      waitingReleases: countOf((status) => status === "pending"),
    },
    recentReleases: recentReleases.map((release) => ({
      id: release.id,
      version: release.version,
      status: release.status,
      statusLabel: releaseStatusLabel(release.status),
      statusTone: releaseStatusTone(release.status),
      sourceLabel: releaseSourceLabel(release.source),
      projectName: release.project.name,
      projectKey: release.project.key,
      packageCount: packageCountByRelease.get(release.id) ?? 0,
      createdAt: release.createdAt,
    })),
    queueTasks: queue.releases
      .flatMap((release) =>
// 行形状与队列页一致（`QueueTaskRow`），只多一个项目名：两页的作业详情弹窗用同一个组件。
        release.tasks.map((task) => ({ ...task, projectName: release.projectName })),
      )
      .slice(0, QUEUE_SUMMARY_LIMIT),
    projects: projectRows.map((project) => {
      const latest = latestByProject.get(project.id) ?? null;
      const edges = projectEdges(project.software);

      return {
        id: project.id,
        key: project.key,
        name: project.name,
        managerName: project.projectManager.name,
        packageCount: project.software.length,
        dependencyCount: edges.length,
        latestVersion: latest?.version ?? null,
        latestStatus: latest?.status ?? null,
        latestStatusLabel: latest === null ? null : releaseStatusLabel(latest.status),
        latestStatusTone: latest === null ? null : releaseStatusTone(latest.status),
        latestAt: latest?.at ?? null,
      };
    }),
    configTodo: {
      missingSoftware: projectRows
        .filter((project) => project.software.length === 0)
        .map(({ id, key, name }) => ({ id, key, name })),
      dependencyCycles: projectRows.flatMap((project) => {
        const cycle = findCycle(projectEdges(project.software));

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
 * 一个项目清单内部的依赖边（下游 → 上游）。
 *
 * 只看清单内部的边：清单外的上游不参与这次提测，构不成先后关系，这与项目卡片的
 * `buildSoftwareView` 是同一个口径（同一份清单在两处不能一个有环、一个没环）。
 * 依赖条数与依赖环检测都用这一份边，不各算一遍。
 */
function projectEdges(software: readonly SoftwareRow[]): DependencyEdge[] {
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

  return edges;
}

/** 一个项目软件清单里的第一条依赖环；检测本身用 `lib/packages`，不在这里另写一套。 */
function findCycle(edges: readonly DependencyEdge[]): string | null {
  const cycle = findDependencyCycle(edges);

  return cycle === null ? null : formatCycle(cycle);
}
