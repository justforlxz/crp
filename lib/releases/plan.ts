/**
 * 提测能不能提交、按什么顺序提交、哪些包有更新。
 *
 * 纯函数：输入是「项目基线状态 + 项目软件清单」，输出是页面与接口共用的结论。
 * 阻断条件（无软件清单、依赖有环、基线未同步）在这里只判定一次，页面用它禁用提交按钮，
 * `POST /api/releases` 用它再拦一次 —— 两处共用同一份判定，不会出现「按钮能点、接口却放行」
 * 或者「按钮禁用了、接口照写」。
 *
 * 依赖边只用清单内部的：清单外的包不在这次提测里，构不成先后关系。
 */

import { baselineBlockReason } from "../projects/baselineGate";
import type { SoftwareEntry } from "../projects/softwareView";
import { buildSoftwareView } from "../projects/softwareView";
import type { BaselineState } from "../baselines/status";
import { formatCycle } from "../packages/dependencyGraph";

/** 阻断原因。`code` 稳定可断言，`message` 直接给页面显示。 */
export type ReleaseBlocker = {
  code: "empty_software" | "dependency_cycle" | "baseline_unavailable";
  message: string;
};

export type ReleaseReadinessInput = {
  /** 项目绑定的 CRP 基线。 */
  baseline: { name: string; state: BaselineState };
  /** 项目软件清单。 */
  entries: readonly SoftwareEntry[];
};

export type ReleaseReadiness = {
  /** 三项阻断条件全部不成立才能提交。 */
  ready: boolean;
  blockers: ReleaseBlocker[];
  /** 上游在前的投递顺序；有环时环上的包按名字附在末尾，不能当投递顺序用。 */
  order: string[];
  /** 清单里的软件包数。 */
  packageCount: number;
  /** 清单内部的依赖边数。 */
  dependencyCount: number;
};

/**
 * 判定一次提测能不能提交。
 *
 * 三条阻断条件都必须成立才放行，且都要给出「去哪里修」：
 *
 * - 无软件清单 → 去项目详情页加包；
 * - 依赖有环 → 去软件包管理改依赖；
 * - 基线未同步（已消失 / 同步失败 / 从未同步）→ 基线拿不到仓库版本，快照会缺 `repoVersion`。
 *
 * 「无变化」的软件包不在阻断条件里：MUST 全部进提测，不因无变化排除。
 */
export function evaluateReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadiness {
  const view = buildSoftwareView(input.entries);
  const blockers: ReleaseBlocker[] = [];

  if (view.count === 0) {
    blockers.push({
      code: "empty_software",
      message: "项目还没有软件清单，先到项目详情页把要提测的软件包加进来。",
    });
  }

  if (view.cycle !== null) {
    blockers.push({
      code: "dependency_cycle",
      message:
        `软件依赖存在环：${formatCycle(view.cycle)}。` +
        "请到软件包管理修正依赖关系，环上的包排不出投递顺序。",
    });
  }

  const baselineReason = baselineBlockReason({
    name: input.baseline.name,
    state: input.baseline.state,
  });

  if (baselineReason !== null) {
    blockers.push({ code: "baseline_unavailable", message: baselineReason });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    order: view.order,
    packageCount: view.count,
    dependencyCount: view.dependencyCount,
  };
}

/** 「本次将提测 N 个软件，其中 M 个有更新」里的两个数字。 */
export type ReleaseChangeSummary = {
  /** 本次提测的软件包数。 */
  total: number;
  /** 其中 Commit 与上次提测不同的包数。 */
  changed: number;
  /** 页面直接显示的一句话。 */
  summary: string;
};

/**
 * 统计本次提测里有多少包换了 Commit。
 *
 * 「有更新」只作提示，不影响是否纳入：全部软件包都要进快照。
 * 还没提测过的包（`lastSubmittedCommit` 为空）算有更新。
 */
export function summarizeChanges(
  packages: readonly { changed: boolean }[],
): ReleaseChangeSummary {
  const total = packages.length;
  const changed = packages.filter((item) => item.changed).length;

  return {
    total,
    changed,
    summary: `本次将提测 ${total} 个软件，其中 ${changed} 个有更新。`,
  };
}
