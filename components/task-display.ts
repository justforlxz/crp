/**
 * 构建任务与架构状态的显示映射（界面规范 v2 第七节 `模块对照`）。
 *
 * 队列页的列表、作业详情弹窗、依赖说明弹窗三处都要按同一个状态上色、写同一句说明。
 * 放在这里而不是各写一份，是为了让「同一个阶段在三处不会出现三种颜色」。
 *
 * 纯模块：只认状态字符串，不碰数据库，服务端组件与客户端组件都能引。
 *
 * `build_status` 的中文名用 `lib/build/stage.ts` 的 `buildStatusLabel`，这里只补
 * 「色点档位」与「这一行的说明」这两件纯显示的事 —— 同一个状态在页面上的两种表达方式。
 */

import { buildStatusLabel } from "@/lib/build/stage";
import type { StagePhase } from "@/lib/build/stage";

/**
 * 状态点的色档。
 *
 * 原型只有「已完成 / 失败 / 等待」三档，实现里多出「投递中 / 构建中」这一档，用强调色与
 * 「等待」区分开：还在跑的任务与排不上队的任务是两件事。
 */
export const DOT_TONE: Record<StagePhase, string> = {
  success: "is-ok",
  failed: "is-bad",
  running: "is-run",
  waiting: "is-wait",
  queued: "is-wait",
  other: "is-wait",
};

/**
 * 依赖流里一行的档位。它染的是序号节点，不是色点。
 *
 * 构建中既不是等待也不是终态：原型没给这一档配色，保持序号节点的默认样子，
 * 状态由右侧的色点说明。
 */
export const DEP_ROW_TONE: Record<StagePhase, string> = {
  success: "is-done",
  failed: "is-fail",
  waiting: "is-wait",
  queued: "is-wait",
  running: "",
  other: "is-wait",
};

/**
 * 色点里的短标签。
 *
 * `.dot` 是 `white-space: nowrap` 的一行：文字一长，`.dep-row` 的第三列就按最长内容撑开，
 * 中间的包名被挤成一列（375 宽度下实测过）。所以状态点只放状态词 ——
 * 「已阻断（上游 kwin 失败）」截在括号前，括号里的细节留给 `.dep-note`、作业说明与弹窗正文。
 */
export function shortStageLabel(stage: string): string {
  const cut = stage.indexOf("（");

  return cut === -1 ? stage : stage.slice(0, cut);
}

/** 一个架构的状态点档位，取值与 `build_status` 枚举一致。 */
const ARCH_TONE: Record<string, string> = {
  pending: "is-wait",
  building: "is-run",
  success: "is-ok",
  failed: "is-bad",
  canceled: "is-wait",
};

/** 一个架构的说明行：成功的不写耗时（库里只有任务级时间，没有逐架构的耗时，不编一个）。 */
const ARCH_NOTE: Record<string, string> = {
  pending: "排队中",
  building: "正在编译",
  success: "构建成功",
  failed: "构建失败",
  canceled: "已取消",
};

/** 架构状态的色点档位；没见过的状态按「等待」上色，不吞掉行。 */
export function archDotTone(status: string): string {
  return ARCH_TONE[status] ?? "is-wait";
}

/** 架构状态的说明行；没见过的状态回落到通用的中文状态名，不吞掉行。 */
export function archNote(status: string): string {
  return ARCH_NOTE[status] ?? buildStatusLabel(status);
}
