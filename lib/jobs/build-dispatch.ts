/**
 * 构建投递的推进逻辑：给 worker 与手动触发一个「把在跑的提测都往前推一步」的入口。
 *
 * 调度由常驻的 `pnpm worker` 进程自己维护：`build-dispatch` 作业每 2 分钟直接调用
 * `runBuildDispatch()` 一次。用户手动触发的 `POST /api/releases/{id}/dispatch`
 * 调的是同一个 `advanceRelease()`，没有第二份推进逻辑。
 *
 * 每次只把每条在跑的提测往前推一步，原因见 `lib/build/service.ts`：一步一落库，
 * 进程重启不丢进度；堆在一个请求里跑完整条链，中途挂掉就得从头再来。
 *
 * 单条提测推进失败不中断整轮：CRP 偶尔超时是常态，一条失败不该让别的提测跟着停下。
 * 失败原因留在本轮返回体里，下一轮定时器还会再试同一条。
 *
 * **用谁的凭据**：作业没有登录会话，按每条提测的创建者（`release.created_by_id`）调 CRP
 * （`.agents/spec/product/credentials.md` 第六节）。创建者没配凭据时这一条被跳过、
 * 记 `action: "skipped"` 与原因，其余提测照常推进 —— 既不静默成功，也不阻塞别人。
 *
 * 单轮只推进固定条数，挑活按「最久没被推进的优先」（`release.last_advanced_at` 从旧到新，
 * 为空的最先）：活跃提测多于上限时各条轮流轮到。**不要改回按创建时间取最早的 N 条** ——
 * 那样后创建的提测永远排在后面、永远轮不到（A14 功能检测在 61 条活跃提测下实测复现过）。
 */

import { checkBearerAuth, readBearerToken } from "../auth/bearer";
import {
  ACTIVE_RELEASE_STATES,
  advanceRelease,
  pruneCrpCallLogs,
  type AdvanceResult,
  type BuildOptions,
} from "../build";
import { CredentialMissingError } from "../credentials/errors";
import { prisma } from "../db";

/** 定时入口的 token 环境变量名。与同步任务、软件包接口各用一个，互不通用。 */
export const BUILD_DISPATCH_JOB_TOKEN_ENV = "BUILD_DISPATCH_JOB_TOKEN";

export type BuildDispatchTrigger = "manual" | "schedule";

/** 一条提测本轮的推进结果。 */
export type BuildDispatchItem = {
  releaseId: string;
  version: string;
  /**
   * `error` 表示这条推进抛了错，原因见 `error`；
   * `skipped` 表示创建者没配 CRP 凭据，这一条被跳过（原因同样在 `error` 里）。
   */
  action: AdvanceResult["action"] | "error" | "skipped";
  /** 推进之后的提测状态；出错时是推进之前的状态。 */
  status: string;
  /** 本轮投递的包名。 */
  packageName: string | null;
  /** 本轮被阻断的包名。 */
  blocked: string[];
  error: string | null;
};

export type BuildDispatchSummary = {
  trigger: BuildDispatchTrigger;
  /** 本轮参与推进的提测条数。 */
  releaseCount: number;
  /** 本轮新建 Topic 的条数。 */
  createdTopics: number;
  /** 本轮投递的软件包数。 */
  dispatched: number;
  /** 本轮推进出错的条数。 */
  failed: number;
  /**
   * 因为创建者没配 CRP 凭据而跳过的条数。
   *
   * 单独一档而不是混进 `failed`：这不是系统故障，是「这个人还没配置」，
   * 处理方式完全不同（去「我的账号」配置一次即可）。
   */
  skipped: number;
  items: BuildDispatchItem[];
};

export type BuildDispatchOptions = {
  trigger: BuildDispatchTrigger;
  /** 注入用，测试替换网络实现。 */
  network?: BuildOptions["network"];
  /** 单轮最多推进多少条提测，防止一次拉太多把请求拖过超时。 */
  limit?: number;
};

/** 单轮默认最多推进多少条提测。 */
const DEFAULT_LIMIT = 20;

/** 错误摘要：只留人看得懂的一句，不存整段堆栈。 */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return message.slice(0, 500);
}

/**
 * 把当前在跑的提测各往前推一步。
 *
 * 「在跑的」按状态挑：`pending`（还没建 Topic）、`dispatching`（正在逐个投递）、
 * `building`（已投完等结果）。已终局的提测不碰。
 */
export async function runBuildDispatch(
  options: BuildDispatchOptions,
): Promise<BuildDispatchSummary> {
  const releases = await prisma.release.findMany({
    where: { status: { in: [...ACTIVE_RELEASE_STATES] } },
    orderBy: [
      // 为空表示还没被推进过，排最前。
      { lastAdvancedAt: { sort: "asc", nulls: "first" } },
      // 同一时刻入队的按创建时间、再按主键定序，保证每一轮挑出来的名单稳定可复现。
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: options.limit ?? DEFAULT_LIMIT,
    select: { id: true, version: true, status: true },
  });

  const summary: BuildDispatchSummary = {
    trigger: options.trigger,
    releaseCount: releases.length,
    createdTopics: 0,
    dispatched: 0,
    failed: 0,
    skipped: 0,
    items: [],
  };

  for (const release of releases) {
    try {
      const result = await advanceRelease(release.id, { network: options.network });

      if (result.action === "topic_created") {
        summary.createdTopics += 1;
      }

      if (result.action === "dispatched") {
        summary.dispatched += 1;
      }

      summary.items.push({
        releaseId: release.id,
        version: release.version,
        action: result.action,
        status: result.status,
        packageName: result.packageName,
        blocked: result.blocked.map((item) => item.packageName),
        error: null,
      });
    } catch (error) {
      const message = errorSummary(error);
      const skipped = error instanceof CredentialMissingError;

      if (skipped) {
        summary.skipped += 1;
        console.warn(`[build-dispatch] 提测 ${release.id} 跳过：${message}`);
      } else {
        summary.failed += 1;
        console.error(`[build-dispatch] 提测 ${release.id} 推进失败：${message}`);
      }

      summary.items.push({
        releaseId: release.id,
        version: release.version,
        action: skipped ? "skipped" : "error",
        status: release.status,
        packageName: null,
        blocked: [],
        error: message,
      });
    } finally {
      // 不管这一条推进成功还是失败，都记上「这一轮处理过它了」：
      // 一条一直失败的提测不能永远占住队首。
      // 这一步写失败只记一行日志：这一条没记上，下一轮会重复推进它，代价很小；
      // 让它把整轮抛掉，后面的提测这一轮都拿不到处理，本轮汇总也一起丢了。
      try {
        await prisma.release.updateMany({
          where: { id: release.id },
          data: { lastAdvancedAt: new Date() },
        });
      } catch (error) {
        console.warn(
          `[build-dispatch] 提测 ${release.id} 记录推进时间失败：${errorSummary(error)}`,
        );
      }
    }
  }

  // CRP 调用记录只留最近一段时间：顺带在每轮清理一次，不另建定时器。
  try {
    const pruned = await pruneCrpCallLogs();

    if (pruned > 0) {
      console.info(`[build-dispatch] 清理过期调用记录 ${pruned} 条`);
    }
  } catch (error) {
    console.warn(`[build-dispatch] 清理过期调用记录失败：${errorSummary(error)}`);
  }

  console.info(
    `[build-dispatch] 触发=${options.trigger} 提测=${summary.releaseCount} 条` +
      ` 新建 Topic=${summary.createdTopics} 投递=${summary.dispatched}` +
      ` 失败=${summary.failed} 跳过=${summary.skipped}`,
  );

  return summary;
}

export type BuildDispatchAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_token" | "invalid_token" };

/**
 * 定时入口的鉴权：`Authorization: Bearer <BUILD_DISPATCH_JOB_TOKEN>`。
 *
 * 没配置 token 时一律拒绝（fail closed）：投递会真的向 CRP 建 Topic、发 Release，
 * 不能退化成「谁都能触发」。
 */
export function checkBuildDispatchJobAuth(
  request: Request,
  source: Record<string, string | undefined> = process.env,
): BuildDispatchAuthResult {
  return checkBearerAuth(request, readBearerToken(BUILD_DISPATCH_JOB_TOKEN_ENV, source));
}
