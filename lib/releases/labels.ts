/**
 * 提测状态与来源的中文名、配色档位（纯常量与纯函数）。
 *
 * 单独一个文件是为了让**客户端组件**也能用：`list.ts` 在模块加载时就建数据库连接，
 * 客户端组件引它会连带把 Prisma 拉进浏览器包。这里不 import 任何服务端模块。
 *
 * 口径来自 `design.md` 5.1 与界面规范 v2 第七节：状态一律「色点 + 文字」，
 * 颜色只由档位决定，文案取 `releaseStatusLabel()`。放在这里而不是页面里：工作台、
 * 提测记录、详情页与创建结果页都要用，逐页抄一份迟早会出现几页配色不一致。
 */

import type { ReleaseStatus } from "../../generated/prisma/enums";

/** 行内显示的精确状态名。 */
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  pending: "排队中",
  dispatching: "投递中",
  building: "构建中",
  success: "成功",
  partial_failure: "部分失败",
  failed: "失败",
  abandoned: "已放弃",
};

/** 来源标签：平台创建 / 从 CRP 导入。 */
export const RELEASE_SOURCE_LABELS: Record<"platform" | "imported", string> = {
  platform: "平台创建",
  imported: "从 CRP 导入",
};

/** 状态的中文名；认不出的取值原样返回，不显示成空白。 */
export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABELS[status as ReleaseStatus] ?? status;
}

/** 来源的中文名；认不出的取值原样返回。 */
export function releaseSourceLabel(source: string): string {
  return RELEASE_SOURCE_LABELS[source as "platform" | "imported"] ?? source;
}

/**
 * 状态 pill 的配色档位（界面规范 v1 的 `.p-*`）。只决定颜色，不改任何文案。
 *
 * 界面规范 v2 的页面改用 `releaseStatusTone()`；这个函数留给还没迁移的页面
 * （提测详情等，属 MKACG-984），两代并存期间不要删。
 */
export function releaseStatusPillClass(status: string): string {
  if (status === "success") {
    return "pill p-green";
  }

  if (status === "failed" || status === "partial_failure") {
    return "pill p-red";
  }

  if (status === "abandoned") {
    return "pill p-orange";
  }

  if (status === "dispatching" || status === "building") {
    return "pill p-blue";
  }

  return "pill p-gray";
}

/**
 * 状态点在页面上的档位（原型 `.is-ok` / `.is-warn` / `.is-bad` / `.is-wait` / `.is-run`）。
 *
 * | 档位 | 状态 |
 * | --- | --- |
 * | `is-ok` | 成功 |
 * | `is-bad` | 失败、部分失败 |
 * | `is-run` | 投递中、构建中 |
 * | `is-wait` | 待投递、已放弃 |
 */
export function releaseStatusTone(status: string): string {
  if (status === "success") {
    return "is-ok";
  }

  if (status === "failed" || status === "partial_failure") {
    return "is-bad";
  }

  if (status === "dispatching" || status === "building") {
    return "is-run";
  }

  return "is-wait";
}
