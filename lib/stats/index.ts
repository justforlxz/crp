/**
 * `lib/stats` 的公开出口。在 `lib/stats` 之外只从这里 import。
 *
 * | 能力 | 入口 |
 * | --- | --- |
 * | 工作台一屏的数据（统计卡、最近提测、队列摘要、项目概况、配置待办） | `loadDashboard` |
 * | 「本周」「成功率」的口径与纯函数 | `STATS_WINDOW_DAYS`、`recentWindowStart`、`successRatePercent` |
 */

export {
  loadDashboard,
  type ConfigTodo,
  type DashboardCards,
  type DashboardView,
  type LoadDashboardOptions,
  type ProjectOverviewRow,
  type QueueSummaryRow,
  type RecentReleaseRow,
} from "./dashboard";

export {
  recentWindowStart,
  SETTLED_RELEASE_STATUSES,
  STATS_WINDOW_DAYS,
  successRatePercent,
} from "./period";
