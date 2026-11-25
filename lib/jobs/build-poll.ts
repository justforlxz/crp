/**
 * 构建轮询的定时入口：给 worker 与手动触发一个「把在跑的提测都轮询一遍」的入口。
 *
 * 轮询逻辑本身在 `lib/build/poller.ts`：队列页的「手动刷新」也调它，两条入口共用同一段代码。
 * 这里只放触发入口的 token 与鉴权 —— 与同步任务、投递任务的 token 各用一个，互不通用。
 */

import { checkBearerAuth, readBearerToken } from "../auth/bearer";

/** 定时入口的 token 环境变量名。与 SYNC_JOB_TOKEN、BUILD_DISPATCH_JOB_TOKEN 互不通用。 */
export const BUILD_POLL_JOB_TOKEN_ENV = "BUILD_POLL_JOB_TOKEN";

export type BuildPollAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_token" | "invalid_token" };

/**
 * 定时入口的鉴权：`Authorization: Bearer <BUILD_POLL_JOB_TOKEN>`。
 *
 * 没配置 token 时一律拒绝（fail closed）：轮询会真的去问 CRP 与 Shuttle，
 * 不能退化成「谁都能触发」。轮询不写业务状态，但它会改 `crp_work_progress`，
 * 而 A17 拿这个值判断能不能改包，所以入口同样要认人。
 */
export function checkBuildPollJobAuth(
  request: Request,
  source: Record<string, string | undefined> = process.env,
): BuildPollAuthResult {
  return checkBearerAuth(request, readBearerToken(BUILD_POLL_JOB_TOKEN_ENV, source));
}
