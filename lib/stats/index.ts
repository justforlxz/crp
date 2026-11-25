/**
 * `lib/stats` 的公开出口。在 `lib/stats` 之外只从这里 import。
 *
 * | 能力 | 入口 |
 * | --- | --- |
 * | 工作台一屏的数据（统计卡、最近提测、队列摘要、项目概况、配置待办） | `loadDashboard` |
 * | 侧栏徽标上的两个数（提测总数、未跑完的提测数） | `loadNavCounts` |
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

export { loadNavCounts, type NavCounts } from "./nav";
