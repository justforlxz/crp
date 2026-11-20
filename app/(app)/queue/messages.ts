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

/**
 * 一条失败的提测：页面只要版本号与它属于哪一类失败，错误原文只进日志。
 *
 * `rateLimited` 为真表示这次失败是 CRP 限流（429）。它属于「等一等」，不属于「去查」，
 * 所以页面上要与其它失败分开说。
 */
export type PollFailureInput = {
  version: string;
  error: string | null;
  rateLimited?: boolean;
};

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
 * 按失败类型分组说：限流只要等，其它失败要查。混成一句「失败」会让人去查链路，
 * 而限流窗口里唯一正确的做法是等。
 *
 * 只报是哪几条提测、属于哪一类：它们的状态已保持原样，错误原文留在服务端日志。
 */
export function reportItemFailures(failed: readonly PollFailureInput[]): string {
  console.error(
    `[queue] 本轮有 ${failed.length} 条提测轮询失败：` +
      failed.map((item) => `${item.version}（${item.error ?? "原因未知"}）`).join("；"),
  );

  const limitWaiting = failed.filter((item) => item.rateLimited === true);
  const otherFailures = failed.filter((item) => item.rateLimited !== true);
  const versions = (picked: readonly PollFailureInput[]): string =>
    picked.map((item) => item.version).join("、");
  const groups = [
    limitWaiting.length === 0 ? null : `限流等待：${versions(limitWaiting)}`,
    otherFailures.length === 0 ? null : `其它失败：${versions(otherFailures)}`,
  ].filter((group): group is string => group !== null);

  return (
    `部分提测轮询失败，状态已保持原样（${groups.join("；")}）。` +
    "明细见服务端日志。"
  );
}
