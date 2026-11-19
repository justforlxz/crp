/**
 * `/queue` 页面提示与明细的分层。
 *
 * 页面只给归类后的一句话，明细走服务端日志：`items[].error` 里可能是 Prisma 的表名、
 * 约束名、SQL 片段，也可能是 CRP / Shuttle 的接口地址。这些属于服务端排障信息，
 * 不该出现在页面上 —— 与 `app/(app)/writeGuard.ts` 的 `messageOf` 是同一条约定。
 *
 * 明细同时仍留在接口返回里（`/api/jobs/build-poll` 的 `items[].error`），
 * 需要看原文的地方从那里取，不再从页面提示里取。
 */

/** 一条失败的提测：页面只要版本号，错误原文只进日志。 */
export type PollFailureInput = { version: string; error: string | null };

/**
 * 一整轮都跑不起来时的页面提示。
 *
 * 走到这里说明连挑活都读不了库，异常原文可能带表名与连接串。
 */
export function reportPollCrash(error: unknown): string {
  console.error("[queue] 本轮轮询没有跑起来：", error);

  return "轮询没有跑起来，请稍后重试。明细见服务端日志。";
}

/**
 * 部分提测轮询失败时的页面提示。
 *
 * 只报是哪几条提测出了问题：它们的状态已保持原样，用户要做的只是稍后再点一次。
 */
export function reportItemFailures(failed: readonly PollFailureInput[]): string {
  console.error(
    `[queue] 本轮有 ${failed.length} 条提测轮询失败：` +
      failed.map((item) => `${item.version}（${item.error ?? "原因未知"}）`).join("；"),
  );

  return (
    `部分提测轮询失败，状态已保持原样：${failed.map((item) => item.version).join("、")}。` +
    "明细见服务端日志。"
  );
}
