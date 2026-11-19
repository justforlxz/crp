/**
 * 工作台统计的取数口径（A15）。
 *
 * 页面副标题写的是「本周 = 最近 7 天」「成功率 = 已有结论的提测里成功的占比」，
 * 这里就是那两句话的实现，页面与测试共用同一份常量与函数，口径只有一处。
 *
 * 纯函数：不读数据库、不读时钟，参数决定结果。
 */

/** 「本周」按最近多少天算。页面副标题直接引用这个数，改口径只改这里。 */
export const STATS_WINDOW_DAYS = 7;

/**
 * 「已有结论」的提测状态：成功、部分失败、失败、已放弃。
 *
 * 就是提测记录列表里「成功」「失败」两个页签覆盖的那两组状态（`lib/releases/list.ts`
 * 的 `RELEASE_TAB_STATUSES`），本页成功率的分母必须与那两个页签数出来的是同一批提测。
 * 排队中、投递中、构建中的都还在跑，不能算进来，否则成功率会因为「刚提测完还没构建完」而永远偏低。
 *
 * 不直接 import 那份常量：`lib/releases/list.ts` 在模块加载时就建数据库连接，
 * 这一层是纯函数，不能因为引用四个状态字符串就把环境变量变成必需项。
 * 两边取值是否一致由 `tests/stats-dashboard.test.ts` 里那条「与提测列表页签同口径」的用例比对；
 * `tests/stats-period.test.ts` 另外锁住这四个取值本身。
 */
export const SETTLED_RELEASE_STATUSES: readonly string[] = [
  "success",
  "partial_failure",
  "failed",
  "abandoned",
];

/** 最近 `days` 天窗口的起点（含）：滚动窗口，不按自然周、不对齐零点。 */
export function recentWindowStart(now: Date, days: number = STATS_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * 成功率（百分比，整数）。
 *
 * 分母是「已有结论的提测数」。一条结论都没有时返回 `null`：页面显示「—」，
 * 显示 0% 会被读成「全失败」。
 */
export function successRatePercent(success: number, settled: number): number | null {
  if (settled <= 0) {
    return null;
  }

  return Math.round((success / settled) * 100);
}
