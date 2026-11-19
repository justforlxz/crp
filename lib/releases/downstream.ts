/**
 * 传递下游的计算规则（A17）。
 *
 * 换掉一个上游包之后，所有依赖它的包（直接下游、下游的下游……）都是基于旧上游构建出来的，
 * 必须一起作废重投。计算这件事只用一张图：
 *
 * - 一条边 `{ from: "A", to: "B" }` 表示「A 依赖 B」，也就是 B 是 A 的上游；
 * - 从被换掉的包出发，顺着「谁依赖它」反向走到底，走出来的就是它的全部传递下游；
 * - 只认本提测里的包：清单外的包不参与这次提测，构不成先后关系。
 *
 * 这里是纯函数：不读数据库、不读网络，参数决定结果，因此单链、分叉、菱形三种形态
 * 都能用单测固定住（AC7）。
 */

import type { DependencyEdge } from "../packages/dependencyGraph";

/**
 * 找出这些包的**全部传递下游**（不含自己），按包名排序，保证同样的输入必然给同样的顺序。
 *
 * - 多层：A → B → C 时改 A，结果里有 B 与 C；
 * - 分叉：B 与 C 都依赖 A 时改 A，两者都在结果里；
 * - 菱形：B、C 依赖 A，D 依赖 B 与 C 时改 A，结果里 B、C、D 各出现一次；
 * - 环：图里即使有环（A5 在建提测时已经拦过，这里不假设数据一定干净）也能停下，不死循环。
 *
 * 只返回 `inside` 里的包名：不在这次提测里的包没有 CRP Release 可放弃，也不需要重投。
 */
export function collectDownstream(
  changed: readonly string[],
  edges: readonly DependencyEdge[],
  inside: ReadonlySet<string>,
): string[] {
  /** 谁依赖谁：键是上游，值是以它为上游的下游。 */
  const dependents = new Map<string, string[]>();

  for (const { from, to } of edges) {
    if (!inside.has(from) || !inside.has(to)) {
      continue;
    }

    const list = dependents.get(to);

    if (list === undefined) {
      dependents.set(to, [from]);
    } else if (!list.includes(from)) {
      list.push(from);
    }
  }

  const found = new Set<string>();
  const seen = new Set<string>(changed);
  const queue = [...changed];

  while (queue.length > 0) {
    const name = queue.shift() as string;

    for (const dependent of dependents.get(name) ?? []) {
      // 被改动的包自己不算下游：它是换包的直接对象，由调用方单独处理。
      if (seen.has(dependent)) {
        continue;
      }

      seen.add(dependent);
      found.add(dependent);
      queue.push(dependent);
    }
  }

  return [...found].sort();
}
