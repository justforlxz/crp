/**
 * 基线能不能被项目选中：把 A9 的基线状态翻成一句拒绝的话。
 *
 * 基线状态本身由 `lib/baselines/status.ts` 的 `baselineState()` 算出（已消失 / 同步失败 /
 * 已同步 / 未同步），这里不重复判定，只决定「这个状态能不能当项目的提测基线」。
 *
 * 抽成纯函数的原因：A10 一开始只看 `synced_at` 非空，A9 合并进来之后出现了两种「有时间戳但
 * 其实不可用」的基线（从 CRP 消失、最近一次同步失败），两种口径在同一个平台上打架。
 * 现在两边共用 A9 的判定，四种状态都在单测里固定住。
 */

import type { BaselineState } from "../baselines/status";

export type BaselineGateInput = {
  /** 基线名，用在提示里，让人知道说的是哪一条。 */
  name: string;
  /** A9 的基线状态。 */
  state: BaselineState;
};

/**
 * 不能选的原因；能选返回 `null`。
 *
 * 四种状态只有 `synced` 放行：已消失的分支再同步也不会回来，同步失败的缓存来自上一轮，
 * 未同步的基线里根本没有软件包版本 —— 三种情况下 A11 建提测都会拿到错的或空的版本。
 */
export function baselineBlockReason(input: BaselineGateInput): string | null {
  switch (input.state) {
    case "synced":
      return null;
    case "missing":
      return `基线 ${input.name} 已从 CRP 分支列表消失，不能再作为项目的提测基线。`;
    case "failed":
      return `基线 ${input.name} 最近一次软件包版本同步失败，修好之后才能选。`;
    case "unsynced":
      return `基线 ${input.name} 还没有同步过，暂时不能作为项目的提测基线。`;
  }
}
