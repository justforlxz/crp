/**
 * 提测详情页要显示的「状态流转与活动记录」与风险提示，从提测数据推导出来（MKACG-970）。
 *
 * 页面只负责摆位置，判定都在这里：一条留痕怎么写、什么时候该出 `.risk-box`，都是纯函数，
 * 单测可以直接喂数据、断言结果，不必连数据库、也不必渲染页面。
 *
 * 入参用 `Pick` 限定到用得到的字段：单测造数据不用补齐整个 `ReleaseDetail`。
 */
import { releaseStatusLabel, releaseUpdateActionLabel } from "@/lib/releases";
import type { ReleaseDetail, ReleaseDetailHistoryRow } from "@/lib/releases";

/** 时间线上的一条记录。 */
export type DetailTimelineEntry = {
  /** React 列表用的稳定 key。 */
  key: string;
  /** 圆点的 class：原型只有蓝色（当前状态）与默认灰两种。 */
  dotClass: string;
  title: string;
  meta: string;
  /** 补充说明，一条一行。 */
  notes: string[];
};

/** `.risk-box` 里的一条：标题 + 正文。 */
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
  | "history"
  | "createdByName"
  | "createdAt"
>;

/**
 * 时间线：最新在上面（原型里「本次提测」就排在第一行），一条记录一个 `.tl-item`。
 *
 * 当前状态、每一次补包换包、建提测时的第一轮 —— 三样都在，所以提测没有任何更新历史时
 * 时间线仍有两条记录，不会出现空壳。
 */
export function buildTimeline(detail: TimelineInput): DetailTimelineEntry[] {
  return [
    {
      key: "current",
      dotClass: "tl-dot blue",
      title: `当前状态 · ${releaseStatusLabel(detail.status)}`,
      meta: `第 ${detail.revision} 轮 · ${
        detail.workProgress === null
          ? (detail.workProgressError ?? "CRP 工作流进度读不到")
          : `CRP 工作流进度 ${detail.workProgress}（${detail.workProgressLabel ?? "未知状态"}）`
      }`,
      notes: [],
    },
    ...detail.history.map((row) => ({
      key: `history-${row.id}`,
      dotClass: "tl-dot",
      title: `${releaseUpdateActionLabel(row.action)} · 第 ${row.revisionBefore} 轮 → 第 ${row.revisionAfter} 轮`,
      meta: `${formatTime(row.createdAt)} · ${row.operatorName}`,
      notes: historyNotes(row),
    })),
    {
      key: "created",
      dotClass: "tl-dot",
      title: "创建提测 · 第 1 轮",
      meta: `${detail.createdByName} · ${formatTime(detail.createdAt)}`,
      notes: [],
    },
  ];
}

type RiskInput = Pick<ReleaseDetail, "status" | "lockReason">;

/**
 * `.risk-box` 的内容：构建没通过、现在改不了。两样都没有就返回空数组，页面整块不渲染。
 *
 * 包为 0、没有构建记录的提测状态是「待投递」，两样都不成立，所以不会出现空壳（AC4）。
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

  return items;
}
