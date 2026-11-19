/**
 * 从 CRP 导入提测时的映射表：CRP Release 的构建状态 → 本平台的快照状态与提测状态。
 *
 * 纯函数模块，不 import Prisma 生成物：同一张表要同时被接口、页面与单测读，
 * 规则只有这一份，不按调用方各写一遍。
 *
 * 键取自真实 CRP 响应（证据见 `lib/integrations/crp/FINDINGS.md` 第六节）：
 * `UPLOAD_OK`、`UPLOAD_CRP`、`UPLOAD_GIVEUP`，另有 `APPLYING`、`UNKNOWN` 与「没有状态」。
 *
 * 没见过的状态一律按 `pending`（待投递）处理，并在预览里标出来：
 * 猜成 `success` 会让一个没建成的包看起来已经可用，恰恰是导入最不能犯的错。
 */

/** 导入时写在快照上的状态，是 `snapshot_status` 的一个子集。 */
export type ImportedSnapshotStatus = "pending" | "building" | "success" | "failed";

/** 导入时写在提测上的状态，是 `release_status` 的一个子集。 */
export type ImportedReleaseStatus =
  | "pending"
  | "building"
  | "success"
  | "partial_failure"
  | "failed";

/** CRP 构建状态 → 快照状态。比较前统一 `trim().toUpperCase()`。 */
const CRP_BUILD_STATE_TABLE: Readonly<Record<string, ImportedSnapshotStatus>> = {
  // 已成功（实测：上传 CRP 成功）
  UPLOAD_OK: "success",
  BUILD_OK: "success",
  SUCCESS: "success",
  // 正在构建 / 正在上传（实测：UPLOAD_CRP、APPLYING）
  UPLOAD_CRP: "building",
  APPLYING: "building",
  BUILDING: "building",
  UPLOADING: "building",
  // 构建或上传失败（实测：UPLOAD_GIVEUP）
  UPLOAD_FAILED: "failed",
  UPLOAD_GIVEUP: "failed",
  BUILD_FAILED: "failed",
  BUILD_ERROR: "failed",
  FAILED: "failed",
  // 被终止：CRP 侧不会再有结果，按失败处理
  CANCELED: "failed",
  CANCELLED: "failed",
  TERMINATED: "failed",
  KILLED: "failed",
};

/** CRP 明确表示「还没有构建状态」的取值。按 `pending` 处理，但不属于「没见过的状态」。 */
const CRP_NO_STATE_VALUES = new Set(["", "UNKNOWN"]);

export type CrpBuildStateMapping = {
  status: ImportedSnapshotStatus;
  /** CRP 这个取值在映射表里。`false` 表示没见过的状态，预览里要标出来。 */
  known: boolean;
  /** 给人看的说明；已知状态且无需提示时为 `null`。 */
  note: string | null;
};

/** 把 CRP Release 的 `BuildState.state` 翻成快照状态。 */
export function mapCrpBuildState(buildState: string | null | undefined): CrpBuildStateMapping {
  const key = (buildState ?? "").trim().toUpperCase();
  const mapped = CRP_BUILD_STATE_TABLE[key];

  if (mapped !== undefined) {
    return { status: mapped, known: true, note: null };
  }

  if (CRP_NO_STATE_VALUES.has(key)) {
    return {
      status: "pending",
      known: true,
      note: "CRP 还没给出构建状态，导入后按待投递处理。",
    };
  }

  return {
    status: "pending",
    known: false,
    note: `CRP 返回了没见过的构建状态「${buildState ?? ""}」，按待投递处理。`,
  };
}

/**
 * 由每个包的状态推出整条提测的状态。
 *
 * 判定顺序不能换：先看「全部成功」，再看「还有人在跑」，最后才下失败结论。
 * 先判失败会把仍在构建的包一起判掉，那些包的结果再也没机会回写。
 */
export function releaseStatusFromSnapshots(
  statuses: readonly ImportedSnapshotStatus[],
): ImportedReleaseStatus {
  if (statuses.length === 0) {
    return "pending";
  }

  if (statuses.every((status) => status === "success")) {
    return "success";
  }

  if (statuses.some((status) => status === "building")) {
    return "building";
  }

  if (statuses.some((status) => status === "pending")) {
    return "pending";
  }

  return statuses.some((status) => status === "success") ? "partial_failure" : "failed";
}
