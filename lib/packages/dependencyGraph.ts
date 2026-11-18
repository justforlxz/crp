/**
 * 软件包依赖图的环检测。
 *
 * 一条边 `{ from: "A", to: "B" }` 表示「A 依赖 B」，也就是投递时 B 必须先构建成功。
 * 节点用软件包名，因为 `package.name` 全局唯一，报错信息可以直接给人看。
 *
 * 这里是纯函数：不读数据库、不读网络，参数决定结果，因此环的每一种形态都能用单测固定住。
 */

export type DependencyEdge = {
  /** 下游包（依赖别人的那一方）。 */
  from: string;
  /** 上游包（被依赖的那一方）。 */
  to: string;
};

/**
 * 在整张图里找一条环。
 *
 * 返回构成环的包名序列，首尾同名，例如 `["A", "B", "C", "A"]`；没有环返回 `null`。
 * 自依赖（`A → A`）返回 `["A", "A"]`，二元环返回 `["A", "B", "A"]`。
 *
 * 只回报第一条找到的环：调用方要的是「拒绝保存并指出回路」，第一条已经够用。
 */
export function findDependencyCycle(
  edges: readonly DependencyEdge[],
): string[] | null {
  const upstreams = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const list = upstreams.get(from);
    if (!list) {
      upstreams.set(from, [to]);
    } else if (!list.includes(to)) {
      list.push(to);
    }
  }

  /** 当前搜索路径上的节点，用于识别回边。 */
  const onPath = new Set<string>();
  /** 已经确定无环的节点，避免重复搜索。 */
  const finished = new Set<string>();
  const path: string[] = [];

  function visit(node: string): string[] | null {
    if (finished.has(node)) {
      return null;
    }

    if (onPath.has(node)) {
      // 回边：把环从路径里截出来，再接上起点形成首尾同名。
      return [...path.slice(path.indexOf(node)), node];
    }

    onPath.add(node);
    path.push(node);

    for (const upstream of upstreams.get(node) ?? []) {
      const cycle = visit(upstream);
      if (cycle) {
        return cycle;
      }
    }

    path.pop();
    onPath.delete(node);
    finished.add(node);
    return null;
  }

  // 环上的每个节点都必有出边，因此都是 graphs 的键，从键出发就能覆盖全部环。
  for (const node of upstreams.keys()) {
    const cycle = visit(node);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

/** 把环的包名序列拼成给人看的一句话，例如 `A → B → C → A`。 */
export function formatCycle(cycle: readonly string[]): string {
  return cycle.join(" → ");
}

/** 排序结果。 */
export type TopologicalSort = {
  /**
   * 上游在前的顺序，可以直接当投递顺序用。
   *
   * 有环时环上的节点排不出来，会按名字附在末尾，所以这时 `order` 的尾部**不是**可投递顺序，
   * 调用方必须先看 `cycle`：它非空就得把问题摆给人看，不能照着 `order` 往下投。
   */
  order: string[];
  /** 清单里找到的第一条环（首尾同名），没有环为 `null`。 */
  cycle: string[] | null;
};

/**
 * 按依赖排出投递顺序：被依赖的包（上游）排在依赖它的包（下游）前面。
 *
 * 只看 `nodes` 内部的边 —— 一个包依赖清单外的包时，那条边不参与排序（清单外的包不投递，
 * 也就没有先后可言）。清单内同一层可以任意先后的节点按名字排，保证每次调用结果一致，
 * 否则页面上「拓扑排序结果」会随数据库返回顺序抖动。
 *
 * 有环时返回 `cycle`，`order` 里仍然列出全部节点，页面能完整显示清单而不是少几行。
 */
export function sortByDependencies(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
): TopologicalSort {
  const names = [...new Set(nodes)].sort();
  const inside = new Set(names);
  const inList = edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to));

  /** 每个节点在清单内的上游。 */
  const upstreams = new Map<string, Set<string>>();
  for (const name of names) {
    upstreams.set(name, new Set());
  }
  for (const { from, to } of inList) {
    upstreams.get(from)?.add(to);
  }

  const order: string[] = [];
  const emitted = new Set<string>();
  const remaining = [...names];

  for (;;) {
    const index = remaining.findIndex((name) =>
      [...(upstreams.get(name) ?? [])].every((upstream) => emitted.has(upstream)),
    );

    if (index === -1) {
      break;
    }

    const [name] = remaining.splice(index, 1);
    order.push(name);
    emitted.add(name);
  }

  if (remaining.length === 0) {
    return { order, cycle: null };
  }

  // 排不动的节点每个都有一条指回剩余集合的边，所以剩余节点里一定有环。
  const cycle = findDependencyCycle(
    inList.filter((edge) => remaining.includes(edge.from) && remaining.includes(edge.to)),
  );

  return { order: [...order, ...remaining], cycle };
}
