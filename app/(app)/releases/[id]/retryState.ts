/**
 * 软件包快照表「操作」列：这一个包能不能单独重投，不能时原因是什么（MKACG-1011）。
 *
 * 判定都在这里（纯函数），页面只负责摆位置、服务端动作只负责执行：两处用的是同一份结论，
 * 不会出现「按钮能点、点了被拒」或者反过来。
 *
 * 能点的只有两种，与 `design.md` 第九节「行级重新投递」一致：
 *
 * - **失败**：真的构建失败了，重投就是删掉 CRP 侧的旧 Release、按同一份快照参数再发一次；
 * - **等待依赖**（等上游）：上游还没成功，重投本身不发东西，但它会在这次操作里把调度推进一格 ——
 *   页面打开之后上游刚好完成的话，这个包当场就会被投出去。
 *
 * 其余一律禁用，并把原因写在按钮下面（不是 hover 提示）：已成功不用重投；投递中 / 构建中等这一轮
 * 跑完；还没投递的等调度器自己投；被上游失败阻断的等上游先重投。
 *
 * 阶段分类（`phase`）与阶段名（`stage`）来自 `lib/build/stage.ts`，与构建队列页、构建状态区块
 * 同一份口径，所以同一行不会出现两种说法。
 */
import type { StagePhase } from "@/lib/build";

export type PackageActionState = {
  /** 能不能点「重新投递」。 */
  retryable: boolean;
  /** 不能点时写在按钮下面的原因；能点时为空。 */
  reason: string | null;
};

/** 判定要的三个值，就是 `BuildStatusTaskView` 里与阶段有关的那三个字段。 */
export type PackageStage = {
  phase: StagePhase;
  /** 阶段名，例如「失败」「构建中」「等待依赖」。 */
  stage: string;
  /** 被哪个上游阻断；不是被阻断的为 `null`。 */
  blockedBy: string | null;
};

/** 读取时没有这个包的状态（正常情况不会发生）：与「还没投递」一样禁用，不猜它能重投。 */
export const UNKNOWN_PACKAGE_STAGE: PackageStage = {
  phase: "other",
  stage: "未知状态",
  blockedBy: null,
};

export function packageActionState(task: PackageStage): PackageActionState {
  // 被阻断的包自己没有构建过，重投它没有意义：它的上游才是要重投的那个。
  if (task.blockedBy !== null) {
    return { retryable: false, reason: `上游 ${task.blockedBy} 失败，先重投上游` };
  }

  switch (task.phase) {
    case "failed":
    case "waiting":
      return { retryable: true, reason: null };
    case "success":
      return { retryable: false, reason: "已成功，不用重投" };
    case "running":
      return { retryable: false, reason: `正在${task.stage}，等这一轮跑完` };
    case "queued":
      return { retryable: false, reason: "还没投递，调度器会自动投递" };
    default:
      return { retryable: false, reason: `当前是「${task.stage}」，这一轮不能重投` };
  }
}
