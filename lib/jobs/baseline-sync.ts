/**
 * 基线同步：把 CRP 的交付分支与各基线的软件包版本同步到本平台。
 *
 * 两件事分开做、分开记：
 *
 * | 动作 | 数据来源 | 请求数 |
 * | --- | --- | --- |
 * | `syncBaselineList`：分支列表落库，标记消失的分支 | CRP `GET /branches`（无需认证） | 固定 1 次 |
 * | `syncBaselinePackages`：每个基线的软件包版本 | Shuttle 仓库信息 + apt 索引 | 每个基线 2 次 |
 *
 * 三条硬约束，改动时不要破坏：
 *
 * 1. 失败不动业务数据：同步抛错时只把本次 `sync_run` 记成失败并留下原因，`baseline` 与
 *    `baseline_package_version` 一行不改，上一次成功的数据还在；`syncedAt` 也只在成功时才写，
 *    绝不能让一次失败的同步看起来像同步过。
 * 2. 不逐包发请求：整条基线的版本来自 Shuttle 的一个索引文件，一次取回全部。基线只刷新
 *    「被项目选中、且缓存已过期（默认 1 小时）」的那些，不对 108 条分支全量拉取。
 * 3. 不依赖 CRP 凭据：分支列表接口匿名即可访问，同步不能因为没配 `CRP_USERNAME` 就整个失败。
 *
 * 本仓库没有常驻调度进程，每小时由外部定时器 `POST /api/jobs/baseline-sync` 触发；
 * 页面上的手动刷新按钮调的是同一个 `runBaselineSync()`，没有第二份逻辑。
 */

import { checkBearerAuth, readBearerToken } from "../auth/bearer";
import { prisma } from "../db";
import {
  createCrpClient,
  CRP_DEFAULT_BASE_URL,
  CRP_ENV,
  type CrpClient,
} from "../integrations/crp";
import {
  createShuttleClient,
  readShuttleEnv,
  type ShuttleClient,
} from "../integrations/shuttle";

/** 软件包版本缓存的默认有效期：1 小时，与定时刷新的周期一致。 */
export const BASELINE_PACKAGE_TTL_MS = 60 * 60 * 1000;

/** 定时任务入口的 token 环境变量名。 */
export const SYNC_JOB_TOKEN_ENV = "SYNC_JOB_TOKEN";

/** 同步由谁触发，与 `sync_run.trigger` 的枚举一致。 */
export type BaselineSyncTrigger = "manual" | "schedule";

/**
 * 一次同步里记录的请求明细。
 *
 * 留着它是因为「一次同步发了几次请求」必须能被当场复核，不能只在文档里承诺批量。
 */
export type SyncRequestLog = {
  total: number;
  crp: number;
  shuttle: number;
  /** 每次请求的地址，按发生顺序；只截取路径部分就够判断是不是批量了。 */
  urls: string[];
};

/** 参与软件包版本刷新的基线。 */
export type PackageRefreshCandidate = {
  id: string;
  name: string;
  syncedAt: Date | null;
  missingAt: Date | null;
};

export type BaselineListSyncResult = {
  status: "success" | "failed";
  /** CRP 返回的分支条数。 */
  itemCount: number;
  /** 本次新标记为「已消失」的基线数。 */
  missingCount: number;
  errorMessage: string | null;
};

export type BaselinePackageSyncResult = {
  baselineId: string;
  name: string;
  status: "success" | "failed";
  /** 这条基线缓存里的软件包数。 */
  itemCount: number;
  errorMessage: string | null;
};

export type BaselineSyncSummary = {
  trigger: BaselineSyncTrigger;
  list: BaselineListSyncResult;
  /** 本次刷新过的基线，一条一行。 */
  packages: BaselinePackageSyncResult[];
  /** 没参与刷新的基线数：没被项目选中，或缓存还没过期，或已从 CRP 消失。 */
  skippedPackageCount: number;
  /** 本次的请求明细；注入了客户端时（测试）为 `null`。 */
  requests: SyncRequestLog | null;
};

export type BaselineSyncOptions = {
  trigger: BaselineSyncTrigger;
  /** 手动刷新用：不看缓存是否过期，被项目选中的基线一律重拉。 */
  force?: boolean;
  /** 缓存有效期，默认 `BASELINE_PACKAGE_TTL_MS`。 */
  ttlMs?: number;
  /** 注入用，便于测试替换网络层。 */
  now?: Date;
  crp?: Pick<CrpClient, "listBranches">;
  shuttle?: Pick<ShuttleClient, "listBaselinePackages">;
};

/** 事务超时：一条 488 个包的基线要逐条 upsert，默认 5 秒不够。 */
const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

const ERROR_MESSAGE_LIMIT = 500;

/** 错误摘要：`sync_run.error_message` 只留人看得懂的一句，不存整段堆栈。 */
function errorSummary(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return message.slice(0, ERROR_MESSAGE_LIMIT);
}

function createRequestLog(): SyncRequestLog {
  return { total: 0, crp: 0, shuttle: 0, urls: [] };
}

/**
 * 统计请求次数的 fetch 包装。
 *
 * 计数发生在真正发请求的那一层，所以重试也会被计进去 —— 这正是验收要看的口径。
 * 记的是路径，不记请求头：token 不能进日志。
 */
function trackedFetch(log: SyncRequestLog, kind: "crp" | "shuttle"): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    log.total += 1;
    log[kind] += 1;
    log.urls.push(`${kind} ${url}`);
    console.info(`[baseline-sync] ${kind} 请求 ${url}`);

    return fetch(input, init);
  }) as typeof fetch;
}

/** CRP 分支列表不需要认证，所以这里只给地址，不给凭据。 */
function createBranchClient(log: SyncRequestLog): Pick<CrpClient, "listBranches"> {
  const baseUrl = (process.env[CRP_ENV.baseUrl]?.trim() || CRP_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  return createCrpClient({ baseUrl, fetchImpl: trackedFetch(log, "crp") });
}

function createPackageClient(log: SyncRequestLog): Pick<ShuttleClient, "listBaselinePackages"> {
  return createShuttleClient({
    ...readShuttleEnv(),
    fetchImpl: trackedFetch(log, "shuttle"),
  });
}

/**
 * 挑出本次要刷新的基线。
 *
 * 三个条件同时满足才刷新：还在 CRP 里（没消失）、被项目选中、缓存已过期或本次强制刷新。
 * 日期比较用毫秒数，避免两个 `Date` 直接相减时的隐式转换。
 */
export function planPackageRefresh(
  baselines: readonly PackageRefreshCandidate[],
  selectedBaselineIds: ReadonlySet<string>,
  options: { now: Date; ttlMs?: number; force?: boolean },
): PackageRefreshCandidate[] {
  const ttlMs = options.ttlMs ?? BASELINE_PACKAGE_TTL_MS;
  const nowMs = options.now.getTime();

  return baselines
    .filter((item) => item.missingAt === null)
    .filter((item) => selectedBaselineIds.has(item.id))
    .filter((item) => {
      if (options.force === true || item.syncedAt === null) {
        return true;
      }

      return nowMs - item.syncedAt.getTime() >= ttlMs;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 拉一次 CRP 分支列表并落库。
 *
 * 按 `crpBranchId` 幂等写入；本次没出现、而库里仍在的分支标上 `missingAt`，不删行 ——
 * 项目可能还指着它，历史提测记录也要查得到这条基线。
 */
export async function syncBaselineList(
  crp: Pick<CrpClient, "listBranches">,
  options: { trigger: BaselineSyncTrigger; now: Date },
): Promise<BaselineListSyncResult> {
  const run = await prisma.syncRun.create({
    data: {
      kind: "baseline_list",
      status: "running",
      trigger: options.trigger,
      startedAt: options.now,
    },
  });

  try {
    const branches = await crp.listBranches();
    const presentIds = branches.map((branch) => String(branch.id));

    const missingCount = await prisma.$transaction(async (tx) => {
      for (const branch of branches) {
        const crpBranchId = String(branch.id);
        const fields = {
          name: branch.name,
          description: branch.description || null,
          repoType: branch.repoType || null,
          isCheck: branch.isCheck,
          missingAt: null,
        };

        await tx.baseline.upsert({
          where: { crpBranchId },
          create: { crpBranchId, ...fields },
          update: fields,
        });
      }

      // 只改「本次之前还在」的那些行，已经标过的保持原来的消失时间。
      const vanished = await tx.baseline.updateMany({
        where: { crpBranchId: { notIn: presentIds }, missingAt: null },
        data: { missingAt: options.now },
      });

      await tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          itemCount: branches.length,
          finishedAt: new Date(),
        },
      });

      return vanished.count;
    });

    return {
      status: "success",
      itemCount: branches.length,
      missingCount,
      errorMessage: null,
    };
  } catch (error) {
    const message = errorSummary(error);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: message },
    });

    console.error(`[baseline-sync] 分支列表同步失败：${message}`);

    return { status: "failed", itemCount: 0, missingCount: 0, errorMessage: message };
  }
}

/**
 * 刷新一条基线的软件包版本。
 *
 * Shuttle 返回整条基线的全部源码包（`eagle-1071` 124 个、`snipe-2500u2` 488 个），
 * 所以这里是「一次取全部、逐条写缓存」，不是逐包查询。
 *
 * 返回 0 条算成功、缓存清空：CRP 里确实存在「分支还在、交付仓库还没有源码包」的基线
 * （实测 `eagle-1076` 的 `Sources.gz` 就是空的），那是数据本身的真实状态，不是同步失败。
 * 真正的失败会以异常形式抛出来，走下面的 catch 分支，一行缓存都不动。
 */
async function syncOneBaselinePackages(
  shuttle: Pick<ShuttleClient, "listBaselinePackages">,
  baseline: PackageRefreshCandidate,
  options: { trigger: BaselineSyncTrigger; now: Date },
): Promise<BaselinePackageSyncResult> {
  const run = await prisma.syncRun.create({
    data: {
      kind: "baseline_packages",
      status: "running",
      trigger: options.trigger,
      targetId: baseline.id,
      startedAt: options.now,
    },
  });

  try {
    const packages = await shuttle.listBaselinePackages(baseline.name);

    await prisma.$transaction(async (tx) => {
      for (const item of packages) {
        await tx.baselinePackageVersion.upsert({
          where: {
            baselineId_packageName: { baselineId: baseline.id, packageName: item.name },
          },
          create: {
            baselineId: baseline.id,
            packageName: item.name,
            version: item.version,
            fetchedAt: options.now,
          },
          update: { version: item.version, fetchedAt: options.now },
        });
      }

      // 仓库里已经没有的包，缓存里也不该再留着。
      await tx.baselinePackageVersion.deleteMany({
        where: {
          baselineId: baseline.id,
          packageName: { notIn: packages.map((item) => item.name) },
        },
      });

      await tx.baseline.update({
        where: { id: baseline.id },
        data: { syncedAt: options.now },
      });

      await tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          itemCount: packages.length,
          finishedAt: new Date(),
        },
      });
    }, TRANSACTION_OPTIONS);

    return {
      baselineId: baseline.id,
      name: baseline.name,
      status: "success",
      itemCount: packages.length,
      errorMessage: null,
    };
  } catch (error) {
    const message = errorSummary(error);

    // 只改本次的同步记录：缓存与 syncedAt 保持上一次成功的值。
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: message },
    });

    console.error(`[baseline-sync] 基线 ${baseline.name} 的软件包版本同步失败：${message}`);

    return {
      baselineId: baseline.id,
      name: baseline.name,
      status: "failed",
      itemCount: 0,
      errorMessage: message,
    };
  }
}

/** 逐条刷新一批基线，串行：Shuttle 是共享服务，不为了一次同步去并发压它。 */
export async function syncBaselinePackages(
  shuttle: Pick<ShuttleClient, "listBaselinePackages">,
  baselines: readonly PackageRefreshCandidate[],
  options: { trigger: BaselineSyncTrigger; now: Date },
): Promise<BaselinePackageSyncResult[]> {
  const results: BaselinePackageSyncResult[] = [];

  for (const baseline of baselines) {
    results.push(await syncOneBaselinePackages(shuttle, baseline, options));
  }

  return results;
}

/**
 * 跑一次完整同步：先分支列表，再刷新参与刷新的基线的软件包版本。
 *
 * 手动刷新（页面按钮）传 `force: true`，否则按钮在有缓存时点下去什么也不做；
 * 定时任务不传，按 TTL 跳过还没过期的基线。
 */
export async function runBaselineSync(
  options: BaselineSyncOptions,
): Promise<BaselineSyncSummary> {
  const now = options.now ?? new Date();
  // 注入了客户端就不统计请求：真实计数只在真正发请求的那一层才有意义。
  const injected = options.crp !== undefined || options.shuttle !== undefined;
  const log = createRequestLog();

  const crp = options.crp ?? createBranchClient(log);
  const shuttle = options.shuttle ?? createPackageClient(log);

  const list = await syncBaselineList(crp, { trigger: options.trigger, now });

  const [baselines, projects] = await Promise.all([
    prisma.baseline.findMany({
      select: { id: true, name: true, syncedAt: true, missingAt: true },
    }),
    prisma.project.findMany({ where: { deletedAt: null }, select: { baselineId: true } }),
  ]);

  const selected = new Set(projects.map((project) => project.baselineId));
  const targets = planPackageRefresh(baselines, selected, {
    now,
    ttlMs: options.ttlMs,
    force: options.force,
  });

  const packages = await syncBaselinePackages(shuttle, targets, {
    trigger: options.trigger,
    now,
  });

  const summary: BaselineSyncSummary = {
    trigger: options.trigger,
    list,
    packages,
    skippedPackageCount: baselines.length - targets.length,
    requests: injected ? null : log,
  };

  console.info(
    `[baseline-sync] 触发=${options.trigger} 分支列表=${list.status} ${list.itemCount} 条` +
      `（新消失 ${list.missingCount} 条）刷新基线=${packages.length} 个` +
      `（失败 ${packages.filter((item) => item.status === "failed").length} 个）` +
      `跳过=${summary.skippedPackageCount} 个` +
      (injected
        ? " 请求数=未统计"
        : ` 请求数=${log.total}（CRP ${log.crp} 次、Shuttle ${log.shuttle} 次）`),
  );

  return summary;
}

export type SyncJobAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_token" | "invalid_token" };

/**
 * 定时任务入口的鉴权：`Authorization: Bearer <SYNC_JOB_TOKEN>`。
 *
 * 定时器没有浏览器会话，只能用 token；没配置 token 时一律拒绝，不能退化成「谁都能触发同步」。
 */
export function checkSyncJobAuth(
  request: Request,
  source: Record<string, string | undefined> = process.env,
): SyncJobAuthResult {
  return checkBearerAuth(request, readBearerToken(SYNC_JOB_TOKEN_ENV, source));
}
