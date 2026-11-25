/**
 * 侧栏徽标上的两个数字。
 *
 * 原型把「提测记录」「构建队列」的条数挂在侧栏项右侧（`.nav-count`），目的是让人一眼看出
 * 「还有多少活在等你」。这里只算这两个数，别的都不算：
 *
 * | 徽标 | 口径 |
 * | --- | --- |
 * | 提测记录 | 这个工作区全部提测数，所有状态都算 |
 * | 构建队列 | 还没跑完的提测数（待投递、投递中、构建中） |
 *
 * 一次 `groupBy` 同时得到两个数，不额外查一遍。**按提测计，不按软件包计**：点进去看到的
 * 是提测列表与提测队列，徽标要和目标页面数得上。
 *
 * 为什么按「会话记住的工作区」算：侧栏链接不带 `?workspace=`，点下去落到的就是会话工作区
 * （`pickActiveWorkspace` 的兜底），所以徽标统计的就是「点进去会看到的那个工作区」。
 */

import { ACTIVE_RELEASE_STATES } from "../build";
import { prisma } from "../db";

/** 侧栏徽标要的两个数。 */
export type NavCounts = {
  releases: number;
  queue: number;
};

/** 读一个工作区的侧栏徽标数字。 */
export async function loadNavCounts(workspaceId: string): Promise<NavCounts> {
  const rows = await prisma.release.groupBy({
    by: ["status"],
    where: { project: { workspaceId } },
    _count: { _all: true },
  });

  const inFlight = new Set<string>(ACTIVE_RELEASE_STATES);

  return rows.reduce<NavCounts>(
    (totals, row) => ({
      releases: totals.releases + row._count._all,
      queue: totals.queue + (inFlight.has(row.status) ? row._count._all : 0),
    }),
    { releases: 0, queue: 0 },
  );
}
