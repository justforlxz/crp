/**
 * 基线状态的判定。
 *
 * 状态是算出来的，不额外存一列：原因已经分别落在 `baseline`（`missing_at`、`synced_at`）
 * 与 `sync_run`（最近一次同步的结果）里，再存一份状态就多一处可能对不上的地方。
 *
 * 判定顺序：
 *
 * 1. 从 CRP 分支列表里消失了 → 已消失。此时无论缓存多新都不该再被选中。
 * 2. 最近一次软件包版本同步失败 → 同步失败。这一条必须排在「已同步」之前，
 *    否则失败的同步会被上一次成功的时间戳盖住，页面显示成「已同步」。
 * 3. 成功同步过 → 已同步。
 * 4. 其余 → 未同步。
 */

/** 基线的展示状态。 */
export type BaselineState = "missing" | "failed" | "synced" | "unsynced";

/** 状态的中文名，页面与接口共用一份。 */
export const BASELINE_STATE_LABELS: Readonly<Record<BaselineState, string>> = {
  missing: "已消失",
  failed: "同步失败",
  synced: "已同步",
  unsynced: "未同步",
};

/** 判定要用的输入。 */
export type BaselineStateInput = {
  /** 从 CRP 分支列表里消失的时间。 */
  missingAt: Date | null;
  /** 最近一次软件包版本同步成功的时间。 */
  syncedAt: Date | null;
  /** 最近一次软件包版本同步的状态；从未同步过为 `null`。 */
  latestRunStatus: "running" | "success" | "failed" | null;
};

export function baselineState(input: BaselineStateInput): BaselineState {
  if (input.missingAt !== null) {
    return "missing";
  }

  if (input.latestRunStatus === "failed") {
    return "failed";
  }

  return input.syncedAt !== null ? "synced" : "unsynced";
}
