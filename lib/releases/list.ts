/**
 * 提测记录列表：状态页签、项目筛选、按编号 / 版本 / Topic 搜索，以及每行标出来源。
 *
 * 页签的归并规则与中文标签都是纯函数常量，页面与接口共用同一份，保证「页签上的数字」
 * 与「点进去看到的行」出自同一次统计，不会两处各算一遍。
 *
 * `ReleaseStatus` 有 7 个值，页签只有 4 个实在的状态 + 全部，所以归并规则必须写死在这里：
 *
 * | 页签 | 覆盖的状态 | 为什么 |
 * | --- | --- | --- |
 * | 排队中 | `pending`、`dispatching` | 都还没进入构建：一个刚建好，一个正在按依赖顺序投递 |
 * | 构建中 | `building` | 已经有包在编译 |
 * | 成功 | `success` | |
 * | 失败 | `failed`、`partial_failure`、`abandoned` | 三个都是「这次提测没成」 |
 *
 * 行内仍然显示精确状态（例如「投递中」），页签只做粗分类，不丢信息。
 */

import type { ReleaseStatus } from "../../generated/prisma/enums";
import { prisma } from "../db";

/** 页签标识。同时用作查询参数 `?status=` 的取值。 */
export type ReleaseStatusTab = "all" | "queued" | "building" | "success" | "failed";

/** 页面上的页签顺序。 */
export const RELEASE_STATUS_TABS: readonly ReleaseStatusTab[] = [
  "all",
  "queued",
  "building",
  "success",
  "failed",
];

/** 页签显示名。 */
export const RELEASE_TAB_LABELS: Record<ReleaseStatusTab, string> = {
  all: "全部",
  queued: "排队中",
  building: "构建中",
  success: "成功",
  failed: "失败",
};

/** 每个页签覆盖的提测状态。`all` 覆盖全部 7 个。 */
export const RELEASE_TAB_STATUSES: Record<ReleaseStatusTab, readonly ReleaseStatus[]> = {
  all: ["pending", "dispatching", "building", "success", "partial_failure", "failed", "abandoned"],
  queued: ["pending", "dispatching"],
  building: ["building"],
  success: ["success"],
  failed: ["failed", "partial_failure", "abandoned"],
};

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

/**
 * 状态 pill 的配色档位（原型 `.p-*`）。只决定颜色，不改任何文案。
 *
 * 口径来自 `design.md` 5.1：绿 = 成功，红 = 失败，橙 = 警告/已放弃，
 * 蓝 =「投递中、构建中」这类进行中的信息色，中性 = 待投递、排队中。
 *
 * 放在这里而不是页面里：工作台与提测记录都要用，接下来还要迁七页，
 * 逐页抄一份迟早会出现两页配色不一致。
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

/** 来源的中文名；认不出的取值原样返回。 */
export function releaseSourceLabel(source: string): string {
  return RELEASE_SOURCE_LABELS[source as "platform" | "imported"] ?? source;
}

/** 认不出的取值一律当「全部」，不因为一个乱传的查询参数就报错。 */
export function parseStatusTab(value: string | undefined): ReleaseStatusTab {
  return RELEASE_STATUS_TABS.find((tab) => tab === value) ?? "all";
}

/** 列表里的一行。字段都是页面直接显示的，不再二次加工。 */
export type ReleaseListRow = {
  id: string;
  /** 提测版本（Topic 版本号），同一项目内唯一。 */
  version: string;
  /** 提测轮次，从 1 开始。 */
  revision: number;
  status: string;
  source: string;
  /** 当前这一轮的软件包数（被替换掉的旧轮不重复计入）。 */
  packageCount: number;
  projectId: string;
  projectKey: string;
  projectName: string;
  createdByName: string;
  crpTopicId: string | null;
  createdAt: Date;
};

export type ReleaseListQuery = {
  /** 只看这个工作区的提测。 */
  workspaceId: string;
  tab: ReleaseStatusTab;
  /** 只这一个项目；不传表示不按项目筛选。 */
  projectId?: string | null;
  /** 按编号 / 版本 / Topic 搜索的关键字；不传或空白表示不搜索。 */
  keyword?: string | null;
};

export type ReleaseListResult = {
  rows: ReleaseListRow[];
  /** 每个页签在「项目 + 关键字」筛选下的条数，页面直接显示，不再单独数一遍。 */
  counts: Record<ReleaseStatusTab, number>;
};

/** 项目 + 关键字这两个筛选条件，页签统计与行查询共用。 */
function baseWhere(query: ReleaseListQuery) {
  const keyword = query.keyword?.trim() ?? "";

  return {
    project: {
      workspaceId: query.workspaceId,
      ...(query.projectId === undefined || query.projectId === null || query.projectId === ""
        ? {}
        : { id: query.projectId }),
    },
    ...(keyword === ""
      ? {}
      : {
          OR: [
            { version: { contains: keyword, mode: "insensitive" as const } },
            { crpTopicId: { contains: keyword } },
            { project: { key: { contains: keyword, mode: "insensitive" as const } } },
            { project: { name: { contains: keyword, mode: "insensitive" as const } } },
          ],
        }),
  };
}

/**
 * 读一页提测记录。
 *
 * 一次 `groupBy` 拿到各状态条数，据它算出每个页签的数字；行只在选中的页签上查一次。
 * 搜索命中「编号」用两台：`crpTopicId`（CRP 的 Topic 编号）与项目标识 `project.key`。
 */
export async function loadReleaseList(query: ReleaseListQuery): Promise<ReleaseListResult> {
  const where = baseWhere(query);

  const [grouped, releases] = await Promise.all([
    prisma.release.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.release.findMany({
      where: { ...where, status: { in: [...RELEASE_TAB_STATUSES[query.tab]] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        version: true,
        revision: true,
        status: true,
        source: true,
        crpTopicId: true,
        createdAt: true,
        projectId: true,
        project: { select: { key: true, name: true } },
        createdBy: { select: { displayName: true } },
      },
    }),
  ]);

  const byStatus = new Map(grouped.map((row) => [row.status, row._count._all]));
  const counts = {} as Record<ReleaseStatusTab, number>;

  for (const tab of RELEASE_STATUS_TABS) {
    counts[tab] = RELEASE_TAB_STATUSES[tab].reduce(
      (total, status) => total + (byStatus.get(status) ?? 0),
      0,
    );
  }

  // 软件数按「当前轮」数：被替换的旧轮不是这次提测要交付的包。
  const packageCounts = new Map<string, number>();

  if (releases.length > 0) {
    const counted = await prisma.releasePackageSnapshot.groupBy({
      by: ["releaseId"],
      where: { releaseId: { in: releases.map((item) => item.id) }, supersededById: null },
      _count: { _all: true },
    });

    for (const row of counted) {
      packageCounts.set(row.releaseId, row._count._all);
    }
  }

  return {
    counts,
    rows: releases.map((item) => ({
      id: item.id,
      version: item.version,
      revision: item.revision,
      status: item.status,
      source: item.source,
      packageCount: packageCounts.get(item.id) ?? 0,
      projectId: item.projectId,
      projectKey: item.project.key,
      projectName: item.project.name,
      createdByName: item.createdBy.displayName,
      crpTopicId: item.crpTopicId,
      createdAt: item.createdAt,
    })),
  };
}

/** 项目筛选下拉里的一项。 */
export type ReleaseProjectOption = { id: string; key: string; name: string };

/**
 * 工作区里可以筛选的项目。
 *
 * 已软删的项目不出现在下拉里，但它们的历史提测仍然留在列表里（`loadReleaseList` 不按项目删除状态过滤）：
 * 提测记录要查得到自己的项目。
 */
export async function loadReleaseProjectOptions(
  workspaceId: string,
): Promise<ReleaseProjectOption[]> {
  return prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, key: true, name: true },
    orderBy: [{ name: "asc" }],
  });
}
