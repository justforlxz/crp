/**
 * 构建投递的推进逻辑：给外部定时器一个「把在跑的提测都往前推一步」的入口。
 *
 * 本仓库没有常驻调度进程，也不引入队列：由外部定时器（cron 或 systemd timer）每隔几分钟
 * POST 一次 `/api/jobs/build-dispatch`。用户手动触发的 `POST /api/releases/{id}/dispatch`
 * 调的是同一个 `advanceRelease()`，没有第二份推进逻辑。
 *
 * 每次只把每条在跑的提测往前推一步，原因见 `lib/build/service.ts`：一步一落库，
 * 进程重启不丢进度；堆在一个请求里跑完整条链，中途挂掉就得从头再来。
 *
 * 单条提测推进失败不中断整轮：CRP 偶尔超时是常态，一条失败不该让别的提测跟着停下。
 * 失败原因留在本轮返回体里，下一轮定时器还会再试同一条。
 */

import { checkBearerAuth, readBearerToken } from "../auth/bearer";
import {
  ACTIVE_RELEASE_STATES,
  advanceRelease,
  type AdvanceResult,
  type BuildOptions,
} from "../build";
import { prisma } from "../db";

/** 定时入口的 token 环境变量名。与同步任务、软件包接口各用一个，互不通用。 */
export const BUILD_DISPATCH_JOB_TOKEN_ENV = "BUILD_DISPATCH_JOB_TOKEN";

export type BuildDispatchTrigger = "manual" | "schedule";

/** 一条提测本轮的推进结果。 */
export type BuildDispatchItem = {
  releaseId: string;
  version: string;
  /** `error` 表示这条推进抛了错，原因见 `error`。 */
  action: AdvanceResult["action"] | "error";
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
    orderBy: { createdAt: "asc" },
    take: options.limit ?? DEFAULT_LIMIT,
    select: { id: true, version: true, status: true },
  });

  const summary: BuildDispatchSummary = {
    trigger: options.trigger,
    releaseCount: releases.length,
    createdTopics: 0,
    dispatched: 0,
    failed: 0,
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
      summary.failed += 1;

      const message = errorSummary(error);

      console.error(`[build-dispatch] 提测 ${release.id} 推进失败：${message}`);

      summary.items.push({
        releaseId: release.id,
        version: release.version,
        action: "error",
        status: release.status,
        packageName: null,
        blocked: [],
        error: message,
      });
    }
  }

  console.info(
    `[build-dispatch] 触发=${options.trigger} 提测=${summary.releaseCount} 条` +
      ` 新建 Topic=${summary.createdTopics} 投递=${summary.dispatched}` +
      ` 失败=${summary.failed}`,
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
