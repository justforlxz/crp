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
