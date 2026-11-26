/**
 * 提测详情页要显示的「状态流转与活动记录」与风险提示，从提测数据推导出来（MKACG-970 / MKACG-984）。
 *
 * 页面只负责摆位置，判定都在这里：一条留痕怎么写、什么时候该出 `.risk`，都是纯函数，
 * 单测可以直接喂数据、断言结果，不必连数据库、也不必渲染页面。
 *
 * 结构与类名来自 `.agents/spec/design/prototype.html` 的提测详情与 `design.md` §7：
 *
 * - 时间线用 `.timeline` + `.tl-item`（配色档位 `is-ok` / `is-bad` / `is-cur`）+ `.tl-dot` +
 *   `.tl-t` + `.tl-time` + `.tl-d`；档位由提测状态与留痕动作推导，页面上同一份状态只有一种颜色；
 * - 风险用 `.risk`，没有风险就返回空数组，页面整块不渲染，不留空壳（FUNC-08）。
 *
 * 入参用 `Pick` 限定到用得到的字段：单测造数据不用补齐整个 `ReleaseDetail`。
 */
import { releaseStatusLabel, releaseUpdateActionLabel } from "@/lib/releases";
import type { ReleaseDetail, ReleaseDetailHistoryRow } from "@/lib/releases";

/**
 * 时间线上一条记录的配色档位。
 *
 * 只有三种，因为 `.tl-item` 在原型样式表里只定义了三条规则：`is-ok`（绿）、`is-bad`（红）、
 * `is-cur`（蓝 + 光晕）。没有橙色与灰色，所以「已放弃」落到红色、「排队中 / 投递中 / 构建中」
 * 落到蓝色 —— 由 `timelineToneOf()` 从提测状态推导，与概要条的 `.dot` 是同一份状态语义。
 */
export type TimelineTone = "is-ok" | "is-bad" | "is-cur";

/** 时间线上的一条记录。 */
export type DetailTimelineEntry = {
  /** React 列表用的稳定 key。 */
  key: string;
  /** `.tl-item` 上的状态档位，决定圆点颜色。 */
  tone: TimelineTone;
  /** `.tl-t` 里的标题。 */
  title: string;
  /** `.tl-time` 里的时间戳。每条都要有，界面用例 UI-13 要求。 */
  at: string;
  /** `.tl-d`，一条一行；空了就不渲染。 */
  notes: string[];
};

/** `.risk` 里的一条：标题 + 正文。 */
export type DetailRiskItem = {
  key: string;
  title: string;
  body: string;
};

/** 构建没有通过的两个提测状态（`lib/build` 汇总出来的结论）。 */
const FAILED_RELEASE_STATUSES = new Set(["failed", "partial_failure"]);

/** 页面上的时间一律按 UTC 展示，与构建队列页同一套口径。 */
export function formatTime(value: Date | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/**
 * 提测状态 → `.dot` 的配色档位。
 *
 * 口径来自 `design.md` 第五节：绿 = 成功，红 = 失败，橙 = 有更新 / 风险，蓝 = 进行中，灰 = 等待。
 * 状态只用 `.dot` + 文字表达，不用颜色单独承载信息（第十节）。
 */
export function statusDotTone(status: string): string {
  if (status === "success") {
    return "is-ok";
  }

  if (FAILED_RELEASE_STATUSES.has(status)) {
    return "is-bad";
  }

  if (status === "abandoned") {
    return "is-warn";
  }

  if (status === "dispatching" || status === "building") {
    return "is-run";
  }

  return "is-wait";
}
/**
 * 提测状态 → `.tl-item` 的配色档位。
 *
 * 与概要条的 `.dot` 是同一份状态语义：页面上同一个状态只有一种颜色，不会出现「概要条红、
 * 时间线蓝」。`.tl-item` 只有绿 / 红 / 蓝三条规则，所以把 `.dot` 的五档压成三档：
 *
 * | 提测状态 | `.dot` | `.tl-item` |
 * | --- | --- | --- |
 * | 成功 | 绿 `is-ok` | 绿 `is-ok` |
 * | 失败 / 部分失败 / 已放弃 | 红 `is-bad` / 橙 `is-warn` | 红 `is-bad`（没有橙色规则） |
 * | 排队中 / 投递中 / 构建中 | 灰 `is-wait` / 蓝 `is-run` | 蓝 `is-cur`（进行中，没有灰色规则） |
 *
 * 界面用例 FUNC-09 说的「当前状态那条带 `.is-cur`」在「走完创建」的提测上成立：那时状态是
 * 排队中，落到这一档。
 */
export function timelineToneOf(status: string): TimelineTone {
  const tone = statusDotTone(status);

  if (tone === "is-ok") {
    return "is-ok";
  }

  if (tone === "is-bad" || tone === "is-warn") {
    return "is-bad";
  }

  return "is-cur";
}

/**
 * 一条更新留痕的配色档位。
 *
 * 补包、换包是已经发生的一次成功操作（绿）；放弃主题终结了这条提测（红）。
 */
export function historyToneOf(action: string): TimelineTone {
  return action === "abandon_topic" ? "is-bad" : "is-ok";
}

/**
 * 一条更新留痕在时间线上的补充说明。
 *
 * 三个包列表是留痕里各自独立的值，空的不写；CRP Release 只在按包名对不上时才露出原始 ID，
 * 免得同一条记录里既写包名又写 ID。
 */
export function historyNotes(row: ReleaseDetailHistoryRow): string[] {
  const notes: string[] = [];

  if (row.packageNames.length > 0) {
    notes.push(`加的包：${row.packageNames.join("、")}`);
  }

  if (row.abandonedPackages.length > 0) {
    notes.push(`放弃的包：${row.abandonedPackages.join("、")}`);
  } else if (row.abandonedCrpReleaseIds.length > 0) {
    notes.push(`放弃的 CRP Release：${row.abandonedCrpReleaseIds.join("、")}`);
  }

  if (row.redispatchedPackageNames.length > 0) {
    notes.push(`重投的包：${row.redispatchedPackageNames.join("、")}`);
  }

  return notes;
}

type TimelineInput = Pick<
  ReleaseDetail,
  | "status"
  | "revision"
  | "workProgress"
  | "workProgressLabel"
  | "workProgressError"
  | "workProgressSyncedAt"
  | "history"
  | "createdByName"
  | "createdAt"
>;

/**
 * 时间线：按时间正序（旧的在上，当前状态在最后一条），一条记录一个 `.tl-item`。
 *
 * 界面用例 FUNC-09 要求正序排列。每条记录的配色档位：创建提测与每一次补包换包是绿（已经发生），
 * 放弃主题是红（它终结了这条提测），当前状态由 `timelineToneOf()` 从状态推导 —— 进行中的状态
 * 落到 `.is-cur`。三样记录都在，所以提测没有任何更新历史时时间线仍有两条记录，不会出现空壳。
 *
 * 当前状态没有单独的「状态变更时间」字段：`.tl-time` 用 `workProgressSyncedAt`（CRP 工作流进度
 * 最近一次同步的时间），没同步过时显示破折号。这里不拿别的字段冒充状态变更时间。
 */
export function buildTimeline(detail: TimelineInput): DetailTimelineEntry[] {
  const progress =
    detail.workProgress === null
      ? (detail.workProgressError ?? "CRP 工作流进度读不到")
      : `CRP 工作流进度 ${detail.workProgress}（${detail.workProgressLabel ?? "未知状态"}）`;

  return [
    {
      key: "created",
      tone: "is-ok",
      title: "创建提测 · 第 1 轮",
      at: formatTime(detail.createdAt),
      notes: [`创建人：${detail.createdByName}`],
    },
    ...detail.history.map((row) => ({
      key: `history-${row.id}`,
      tone: historyToneOf(row.action),
      title: `${releaseUpdateActionLabel(row.action)} · 第 ${row.revisionBefore} 轮 → 第 ${row.revisionAfter} 轮`,
      at: formatTime(row.createdAt),
      notes: [`操作人：${row.operatorName}`, ...historyNotes(row)],
    })),
    {
      key: "current",
      tone: timelineToneOf(detail.status),
      title: `当前状态 · ${releaseStatusLabel(detail.status)}`,
      at: formatTime(detail.workProgressSyncedAt),
      notes: [`第 ${detail.revision} 轮`, progress],
    },
  ];
}

type RiskInput = Pick<ReleaseDetail, "status" | "lockReason"> & {
  /**
   * 撤回按钮被锁时的样子：按钮文案 + 不能点的原因。能撤回时传 `null` 或不传。
   *
   * 原因要**常驻显示**在时间线区域（`design.md` 第九节「撤回被锁定时」），不做 hover 提示 ——
   * 灰掉的按钮上悬停看不出来为什么不能点，而这是用户下一步该做什么的唯一线索。
   */
  retract?: { label: string; reason: string } | null;
};

/**
 * `.risk` 的内容：构建没通过、现在改不了、现在撤不回。都没有就返回空数组，页面整块不渲染。
 *
 * 包为 0、没有构建记录的提测状态是「待投递」，三条都不成立，所以不会出现空壳（FUNC-08）。
 */
export function buildRiskItems(detail: RiskInput): DetailRiskItem[] {
  const items: DetailRiskItem[] = [];

  if (FAILED_RELEASE_STATUSES.has(detail.status)) {
    items.push({
      key: "build",
      title: "构建没有全部通过",
      body: "这条提测的状态是「失败」：下面构建状态里能看到是哪个包、哪个架构没过。页面只展示，不改任何状态。",
    });
  }

  if (detail.lockReason !== null) {
    items.push({
      key: "lock",
      title: "现在不能更新这条提测",
      body: detail.lockReason,
    });
  }

  // 撤回被锁：原因常驻在这里，按钮在顶栏灰掉。标题用按钮自己的文案，读的人对得上点的是哪个。
  const retract = detail.retract ?? null;

  if (retract !== null) {
    items.push({
      key: "retract",
      title: `现在不能${retract.label}`,
      body: retract.reason,
    });
  }

  return items;
}
