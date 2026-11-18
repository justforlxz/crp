/**
 * 项目软件清单的展示形态：软件数、依赖数、拓扑排序结果、依赖环告警。
 *
 * 纯函数：输入是「清单里每个包叫什么、它有哪些上游」的原始数据，输出是页面直接显示的东西。
 * 数据库查询在 `service.ts`，这里不碰数据库，因此排序与环告警的每一种形态都能用单测固定住。
 *
 * 依赖边不存项目层（`package_dependency` 是唯一一份），所以每次都由清单里的软件包反查出来。
 */

import { sortByDependencies, type DependencyEdge } from "../packages/dependencyGraph";

/** 清单里的一项：包名、本项目跟踪的分支、它全部上游的包名（可能包含清单外的包）。 */
export type SoftwareEntry = {
  packageName: string;
  trackedBranch: string;
  /** 该包的上游包名，来自 `package_dependency`。 */
  upstreamNames: readonly string[];
  /** 上次提测成功时提交的 Commit；还没提测过就是 `null`。 */
  lastSubmittedCommit: string | null;
};

export type SoftwareView = {
  /** 清单里的软件包数。 */
  count: number;
  /** 清单内部的上游依赖边数，也就是决定投递先后关系的那几条边。 */
  dependencyCount: number;
  /** 上游在前的顺序；有环时环上的包按名字附在末尾。 */
  order: string[];
  /** 清单内的第一条依赖环（首尾同名）；没有环为 `null`。 */
  cycle: string[] | null;
  /** 按 `order` 排好的清单，页面直接遍历。 */
  entries: SoftwareEntry[];
};

/**
 * 把清单渲染成页面要的样子。
 *
 * 清单外的上游（这个包依赖了项目里没有的包）不计入 `dependencyCount`，也不参与排序：
 * 那些包不在这次提测里，构不成先后关系。页面上仍然原样列出它们，好让人看出清单不全。
 */
export function buildSoftwareView(entries: readonly SoftwareEntry[]): SoftwareView {
  const names = entries.map((entry) => entry.packageName);
  const inside = new Set(names);

  const edges: DependencyEdge[] = [];
  for (const entry of entries) {
    for (const upstream of entry.upstreamNames) {
      if (inside.has(upstream)) {
        edges.push({ from: entry.packageName, to: upstream });
      }
    }
  }

  const { order, cycle } = sortByDependencies(names, edges);
  const byName = new Map(entries.map((entry) => [entry.packageName, entry]));
  const ordered = order.map((name) => byName.get(name)).filter((entry) => entry !== undefined);

  return {
    count: entries.length,
    dependencyCount: edges.length,
    order,
    cycle,
    entries: ordered,
  };
}

