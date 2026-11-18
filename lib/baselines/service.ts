/**
 * 基线的读取逻辑：列表、同步记录、给其它节点用的版本查询。
 *
 * 写入（同步）在 `lib/jobs/baseline-sync.ts`，这里只读：页面与 A11 都从这里拿数据。
 *
 * 与 A7 的 `lib/packages/baselineVersion.ts` 的区别：那一份是「现场问一次 Shuttle」，
 * 每次都发请求；本文件的 `getBaselineVersion` 只读缓存表 `baseline_package_version`，
 * 缓存由同步任务维护。创建提测要控请求数，用它，不要用它去打 Shuttle。
 */

import { prisma } from "../db";
import { baselineState, BASELINE_STATE_LABELS, type BaselineState } from "./status";

/** 列表页的一行。`state` 与 `stateLabel` 由 `status.ts` 算出，不读库里的列。 */
export type BaselineListItem = {
  id: string;
  crpBranchId: string;
  name: string;
  description: string | null;
  repoType: string | null;
  isCheck: boolean;
  syncedAt: Date | null;
  missingAt: Date | null;
  /** 缓存里有多少个软件包的版本。 */
  packageCount: number;
  /** 有多少个项目选了这条基线。 */
  projectCount: number;
  state: BaselineState;
  stateLabel: string;
  /** 最近一次同步失败的原因；成功的或没同步过为空。 */
  latestError: string | null;
};

/** 最近一次同步记录的最大读取条数：够覆盖所有基线的最近一轮，又不至于把整张表拉进内存。 */
const RECENT_RUN_LIMIT = 500;

/**
 * 基线列表，附「最近一次软件包版本同步」的结果。
 *
 * 一次查出全部同步记录再按 `targetId` 去重，不按基线逐条查：这是页面主查询，
 * 按基线查会变成 N+1。
 */
export async function listBaselines(): Promise<BaselineListItem[]> {
  const [baselines, recentPackageRuns] = await Promise.all([
    prisma.baseline.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { packageVersions: true, projects: true } },
      },
    }),
    prisma.syncRun.findMany({
      where: { kind: "baseline_packages" },
      orderBy: { startedAt: "desc" },
      take: RECENT_RUN_LIMIT,
      select: { targetId: true, status: true, errorMessage: true },
    }),
  ]);

  // 记录已按开始时间倒序，每个 targetId 第一次出现的就是最近一次。
  const latestRun = new Map<string, { status: "running" | "success" | "failed"; errorMessage: string | null }>();

  for (const run of recentPackageRuns) {
    if (run.targetId === null || latestRun.has(run.targetId)) {
      continue;
    }

    latestRun.set(run.targetId, { status: run.status, errorMessage: run.errorMessage });
  }

  return baselines.map((item) => {
    const run = latestRun.get(item.id) ?? null;
    const state = baselineState({
      missingAt: item.missingAt,
      syncedAt: item.syncedAt,
      latestRunStatus: run?.status ?? null,
    });

    return {
      id: item.id,
      crpBranchId: item.crpBranchId,
      name: item.name,
      description: item.description,
      repoType: item.repoType,
      isCheck: item.isCheck,
      syncedAt: item.syncedAt,
      missingAt: item.missingAt,
      packageCount: item._count.packageVersions,
      projectCount: item._count.projects,
      state,
      stateLabel: BASELINE_STATE_LABELS[state],
      latestError: run?.status === "failed" ? run.errorMessage : null,
    };
  });
}

/** 同步记录按种类的中文名。 */
export const SYNC_RUN_KIND_LABELS: Readonly<Record<string, string>> = {
  baseline_list: "基线列表",
  baseline_packages: "基线软件包版本",
  package_metadata: "软件包元数据",
  release_status: "提测状态",
};

/** 同步记录的一行。`targetName` 是 `targetId` 翻出来的基线名，翻不到就原样显示 id。 */
export type SyncRunListItem = {
  id: string;
  kind: string;
  kindLabel: string;
  status: "running" | "success" | "failed";
  trigger: "manual" | "schedule";
  targetName: string | null;
  itemCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
};

/** 最近的同步记录，页面用。 */
export async function listSyncRuns(limit = 20): Promise<SyncRunListItem[]> {
  const runs = await prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  const targetIds = [
    ...new Set(runs.map((run) => run.targetId).filter((id): id is string => id !== null)),
  ];
  const baselines =
    targetIds.length === 0
      ? []
      : await prisma.baseline.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, name: true },
        });
  const nameById = new Map(baselines.map((item) => [item.id, item.name]));

  return runs.map((run) => ({
    id: run.id,
    kind: run.kind,
    kindLabel: SYNC_RUN_KIND_LABELS[run.kind] ?? run.kind,
    status: run.status,
    trigger: run.trigger,
    targetName: run.targetId === null ? null : (nameById.get(run.targetId) ?? run.targetId),
    itemCount: run.itemCount,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorMessage: run.errorMessage,
  }));
}

/** 最近一次基线列表同步，页面顶部用它显示「上一次拉分支列表成没成」。 */
export function getLatestListRun() {
  return prisma.syncRun.findFirst({
    where: { kind: "baseline_list" },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * 查一个软件包在指定基线里的当前版本，缓存里没有就返回 `null`。
 *
 * 只读缓存，不发外部请求：这是 A11 创建提测时给快照填 `repoVersion` 用的。
 * 返回 `null` 表示「这个基线里没有这个包」，或者「这条基线还没同步过」——
 * 调用方要区分这两种情况，看 `baseline.syncedAt`。
 */
export async function getBaselineVersion(
  baselineId: string,
  packageName: string,
): Promise<string | null> {
  const row = await prisma.baselinePackageVersion.findUnique({
    where: { baselineId_packageName: { baselineId, packageName } },
    select: { version: true },
  });

  return row?.version ?? null;
}
