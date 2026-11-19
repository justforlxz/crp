/**
 * 依赖链的推进判定：下一个投哪个包、哪些包被阻断、整条提测到终局没有。
 *
 * 纯函数：输入是「这一轮快照各自的状态 + 各自在本提测内的上游包名」，
 * 输出是「下一个该投递的包 / 因上游失败而必须阻断的包 / 提测的结局」。
 * 不读数据库、不读网络，因此 AC1 的投递顺序、AC2 的阻断范围都能用单测固定住。
 *
 * 四条设计契约落在这里：
 *
 * - **不并发投递依赖链**：`next` 最多一个，且它的上游必须全部成功。
 * - **上游失败必须阻断下游**：阻断沿依赖边传递（A 失败 → B 阻断 → C 也阻断），
 *   并且**永不跳过失败继续投**：一旦有包失败，本函数不再给出 `next`。
 * - **阻断可解释**：每个被阻断的包都带上「因哪个上游失败」。
 * - **终局要等所有人**：还有包在构建时不给结局，否则那些包的结果永远写不回来。
 */

/** 快照状态，取值与 `snapshot_status` 枚举一致。 */
export type ChainStatus =
  | "pending"
  | "dispatching"
  | "building"
  | "success"
  | "failed"
  | "abandoned"
  | "superseded";

/** 依赖链上的一环。 */
export type ChainNode = {
  /** 这一轮快照的 ID，阻断时写进 `build_task.blocked_by_snapshot_id`。 */
  snapshotId: string;
  /** 源码包名。 */
  packageName: string;
  /** 当前快照状态。 */
  status: ChainStatus;
  /**
   * 它在本提测内的上游包名。
   *
   * 清单外的上游不用先过滤：本函数只认本提测里的包名，多给的会自动忽略。
   */
  upstreamNames: readonly string[];
};

/** 一个被阻断的包。 */
export type BlockedNode = {
  snapshotId: string;
  packageName: string;
  /** 造成阻断的上游快照 ID。 */
  blockedBySnapshotId: string;
  /** 造成阻断的上游包名，给页面直接显示。 */
  blockedByName: string;
  /** 给人看的一句话，写进 `build_task.status_reason`。 */
  reason: string;
};

/** 推进结论。 */
export type ChainEvaluation = {
  /** 因上游失败而必须阻断、且此前没有结论的包；已经终止的包不在里面。 */
  newlyBlocked: BlockedNode[];
  /** 下一个该投递的包；没有可投的就是 `null`。 */
  next: ChainNode | null;
  /**
   * 整条提测的结局：`null` 表示还没到终局（有包在构建，或者还能继续投）。
   *
   * - `success`：全部快照成功；
   * - `partial_failure`：有成功的、也有失败或阻断的；
   * - `failed`：一个成功的都没有。
   */
  outcome: "success" | "partial_failure" | "failed" | null;
};

/** 还没投出去的状态：这些才可能被阻断。已抢占（`dispatching`）的包正在投递，不算。 */
const WAITING: ReadonlySet<ChainStatus> = new Set<ChainStatus>(["pending"]);

/** 正在等构建结论的状态。它们决定「能不能给终局」。 */
const RUNNING: ReadonlySet<ChainStatus> = new Set<ChainStatus>(["dispatching", "building"]);

/**
 * 推进一次依赖链。
 *
 * 步骤固定：
 *
 * 1. 找出所有「上游（可传递）里有失败包」的待投递包，标记为阻断，并指出是哪个上游造成的；
 * 2. 已经有一个包失败时，其余还没投出去的包也不会再投了 —— 它们同样标成阻断，
 *    原因写「同一提测里 X 构建失败」，否则这些包会永远停在「待投递」而提测已经是失败；
 * 3. 只要链上有一个包失败，就不再给出下一个投递对象 —— 不跳过失败继续投；
 * 4. 没有失败时，按给定顺序取第一个「上游全部成功」的待投递包；
 * 5. 全部成功、或已有失败包**且没有包还在构建**时给出结局，否则 `outcome` 为空表示还要等。
 *
 * 第 5 条的「没有包还在构建」是关键：先投的包失败时，另一个互不依赖的包可能还在构建。
 * 此时若立刻判失败，提测进入终局，后续推进直接返回，那个包的构建结果就再也写不回来。
 *
 * 「给定顺序」由调用方决定：本函数只按入参顺序扫描，因此同样的输入必然给同样的结果。
 */
export function evaluateChain(nodes: readonly ChainNode[]): ChainEvaluation {
  const byName = new Map(nodes.map((node) => [node.packageName, node]));
  const inside = new Set(byName.keys());

  /** 本提测内的上游包名。 */
  const directUpstreams = new Map<string, string[]>();
  for (const node of nodes) {
    directUpstreams.set(
      node.packageName,
      node.upstreamNames.filter((name) => inside.has(name)),
    );
  }

  const failedNodes = nodes.filter((node) => node.status === "failed");
  const hasFailure = failedNodes.length > 0;
  const newlyBlocked: BlockedNode[] = [];
  const blockedByName = new Map<string, BlockedNode>();

  // 第一轮：上游（可传递）里有失败包的，指出是哪个上游造成的。
  // 传递性必须做，否则 A 失败时只有 B 被标、C 会被当成「上游（B）还没成功」一直等下去。
  for (const node of nodes) {
    if (!WAITING.has(node.status)) {
      continue;
    }

    const cause = findFailedUpstream(node, directUpstreams, byName, blockedByName);
    if (cause === null) {
      continue;
    }

    const blocked: BlockedNode = {
      snapshotId: node.snapshotId,
      packageName: node.packageName,
      blockedBySnapshotId: cause.snapshotId,
      blockedByName: cause.packageName,
      reason: `因上游 ${cause.packageName} 构建失败而阻断，本包没有投递`,
    };

    blockedByName.set(node.packageName, blocked);
    newlyBlocked.push(blocked);
  }

  // 第二轮：链上已经有失败、而且不再投递，那么其余还没投出去的包也不会有结论了。
  // 不标掉它们，提测会以「失败」收尾却留着几个「待投递」的包，谁也推进不了。
  const firstFailed = failedNodes[0];

  if (firstFailed !== undefined) {
    for (const node of nodes) {
      if (!WAITING.has(node.status) || blockedByName.has(node.packageName)) {
        continue;
      }

      const blocked: BlockedNode = {
        snapshotId: node.snapshotId,
        packageName: node.packageName,
        blockedBySnapshotId: firstFailed.snapshotId,
        blockedByName: firstFailed.packageName,
        reason: `同一提测里 ${firstFailed.packageName} 构建失败，本次不再投递本包`,
      };

      blockedByName.set(node.packageName, blocked);
      newlyBlocked.push(blocked);
    }
  }

  const next = hasFailure ? null : findNext(nodes, directUpstreams, byName);

  return { newlyBlocked, next, outcome: outcomeOf(nodes, hasFailure, blockedByName) };
}

/** 顺着上游找到第一个「失败」或「已被阻断」的包；找不到返回 `null`。 */
function findFailedUpstream(
  node: ChainNode,
  directUpstreams: ReadonlyMap<string, string[]>,
  byName: ReadonlyMap<string, ChainNode>,
  blockedByName: ReadonlyMap<string, BlockedNode>,
): { snapshotId: string; packageName: string } | null {
  const seen = new Set<string>();
  const queue = [...(directUpstreams.get(node.packageName) ?? [])];

  while (queue.length > 0) {
    const name = queue.shift() as string;

    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const upstream = byName.get(name);
    if (upstream === undefined) {
      continue;
    }

    if (upstream.status === "failed") {
      return { snapshotId: upstream.snapshotId, packageName: upstream.packageName };
    }

    // 被阻断的包自己不再构建，它的下游要指向真正失败的那个包才会被看懂。
    const blocked = blockedByName.get(name);
    if (blocked !== undefined) {
      return { snapshotId: blocked.blockedBySnapshotId, packageName: blocked.blockedByName };
    }

    queue.push(...(directUpstreams.get(name) ?? []));
  }

  return null;
}

/** 按入参顺序取第一个「上游全部成功」的待投递包。 */
function findNext(
  nodes: readonly ChainNode[],
  directUpstreams: ReadonlyMap<string, string[]>,
  byName: ReadonlyMap<string, ChainNode>,
): ChainNode | null {
  for (const node of nodes) {
    if (node.status !== "pending") {
      continue;
    }

    const upstreams = directUpstreams.get(node.packageName) ?? [];
    const allDone = upstreams.every(
      (name) => byName.get(name)?.status === "success",
    );

    if (allDone) {
      return node;
    }
  }

  return null;
}

/**
 * 全部成功 / 部分成功 / 全失败。还有包在构建或还能继续投时为 `null`。
 *
 * 判定顺序不能换：先看「还有没有人没跑完」，再看结局。反过来的话，
 * 一个包失败时会把仍在构建的包一起判掉，那些包的结果再也没机会回写。
 */
function outcomeOf(
  nodes: readonly ChainNode[],
  hasFailure: boolean,
  blockedByName: ReadonlyMap<string, BlockedNode>,
): ChainEvaluation["outcome"] {
  if (nodes.length === 0) {
    return null;
  }

  if (nodes.every((node) => node.status === "success")) {
    return "success";
  }

  const stillRunning = nodes.some(
    (node) => RUNNING.has(node.status) && !blockedByName.has(node.packageName),
  );

  if (stillRunning || !hasFailure) {
    return null;
  }

  const anySuccess = nodes.some((node) => node.status === "success");

  return anySuccess ? "partial_failure" : "failed";
}
