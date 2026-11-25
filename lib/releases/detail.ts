/**
 * 提测详情的取数（A13）。
 *
 * 一条提测在页面上要看三件事：它是谁、它现在能不能改、它固化了什么。
 *
 * | 区块 | 取数 |
 * | --- | --- |
 * | 概要条 | `Release`（版本、轮次、来源、说明、创建人）+ 项目绑定�� CRP 基线 |
 * | 能不能改 | 直接复用 A17 的 `loadReleaseUpdateView`：锁定规则只有一份，页面不会与更新接口说法不一致 |
 * | 更新历史 | 同上，`ReleaseUpdateRecord` 的整理也在那里 |
 * | 快照表 | `ReleasePackageSnapshot` 当前轮 + `Package.repoPath` + 提交说明与提交人（Gerrit） |
 * | CRP 仓库记录 | `ReleaseRepositoryRecord` |
 *
 * 三个派生值的来源（都不是存储字段，验收时按这几条核对）：
 *
 * 1. **是否使用自定义 Tag**：`releaseVersion !== codeVersion`。建提测时
 *    `releaseVersion = customTag ?? codeVersion`（`lib/releases/snapshot.ts`），两者不等就说明填过
 *    自定义 Tag。没有单独的存储字段。
 * 2. **提交顺序**：按 `PackageDependency` 现算拓扑序，只算提测里的这些包之间的边，
 *    复用 `buildSoftwareView`（A11/A17 的排序实现）。不新增存储字段。
 * 3. **基线 Commit**：同一个包在**这条提测里上一轮**的 Commit。首轮没有上一轮，显示为空 ——
 *    快照表没有存「创建这一轮时项目清单里的上次提测 Commit」这一列，本节点不改数据库结构，
 *    所以不拿可变的 `project_software.last_submitted_commit` 冒充历史值。
 *
 * **提交说明与提交人**来自 Gerrit：两者的取值由 Commit 的全部 40 位散列唯一确定，
 * 一个 Commit 一旦存在就不会改，所以现读与创建当时读到的内容相同。
 * 读不到就留空并附上原因，不影响详情页其余部分渲染。
 */

import type { BuildNetwork } from "../build";
import { prisma } from "../db";
import { CredentialError } from "../credentials/errors";
import { CRP_DEFAULT_BASE_URL } from "../integrations/crp";
import {
  createGerritClientForCurrentUser,
  GerritError,
  type GerritClient,
} from "../integrations/gerrit";
import { buildSoftwareView, type SoftwareEntry } from "../projects/softwareView";
import { ReleaseError } from "./service";
import { loadReleaseUpdateView, type ReleaseUpdateHistoryRow } from "./update";

/**
 * 快照表的 11 列，顺序与 PRD 一致。
 *
 * 页面表头与 CSV 表头都取这一份，两处不可能各写一套列。缺列即不合格（MUST）。
 */
export const SNAPSHOT_COLUMNS = [
  "提交顺序",
  "软件包/仓库",
  "分支",
  "代码版本",
  "基线仓库版本",
  "本次提测版本",
  "是否自定义 Tag",
  "基线 Commit",
  "本次 Commit",
  "提交说明",
  "提交人",
] as const;

/** 快照表里的一行：11 列的数据加几个页面上要用、但不占列的值。 */
export type ReleaseDetailPackage = {
  packageName: string;
  /** 仓库路径，例如 `deepin-kde/kwin`；软件包还没登记时为 `null`。 */
  repoPath: string | null;
  /** 第几轮快照。补包换包会让同一个包出现多轮，表格只显示最新一轮。 */
  attempt: number;
  branch: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  /** 提测版本与代码版本不同，说明填过自定义 Tag。 */
  customTag: boolean;
  /** 同一个包上一轮的 Commit；首轮为 `null`。 */
  baselineCommit: string | null;
  commitSha: string;
  /** 提交说明首行；读不到为 `null`。 */
  commitMessage: string | null;
  /** 提交人（Commit 作者）；读不到为 `null`。 */
  commitAuthor: string | null;
  /** 读不到提交说明 / 提交人的原因；读到了为 `null`。 */
  commitError: string | null;
};

/** CRP 仓库记录关联里的一行。 */
export type ReleaseDetailRepositoryRecord = {
  packageName: string;
  crpReleaseId: string;
  crpBuildId: string | null;
  crpStatusName: string | null;
  /** 从 CRP 同步回来的实际 Tag，可能与提测版本不同（例如 `5.16.21`）；还没同步过为 `null`。 */
  crpTag: string | null;
  /** CRP 记的 `BaseTag`，即我们提交上去的那个版本号（例如 `5.16.20`）；还没同步过为 `null`。 */
  crpBaseTag: string | null;
  repositoryUrl: string | null;
  lastSyncedAt: Date | null;
};

/** 更新历史里的一行：A17 的留痕，加上「放弃的包」按包名的说法。 */
export type ReleaseDetailHistoryRow = ReleaseUpdateHistoryRow & {
  /** 本次在 CRP 侧放弃的 Release 对应的包名；查不到对应包时退回 Release ID。 */
  abandonedPackages: string[];
};

export type ReleaseDetail = {
  releaseId: string;
  version: string;
  revision: number;
  status: string;
  /** `platform` 或 `imported`。 */
  source: string;
  description: string | null;
  createdAt: Date;
  createdByName: string;
  project: { id: string; key: string; name: string; baselineName: string };

  /** 现在能不能走「更新提测」；能改时为 `null`。 */
  lockReason: string | null;
  /** 现读到的 CRP 工作流进度；读不到为 `null`。 */
  workProgress: number | null;
  workProgressLabel: string | null;
  /** 读不到进度的原因。 */
  workProgressError: string | null;

  crpTopicId: string | null;
  /** CRP 网页上的 Topic 地址；没有 Topic 时为 `null`。 */
  crpTopicUrl: string | null;
  crpTopicState: number | null;
  crpTopicAbandoned: boolean | null;
  crpTopicCompleted: boolean | null;
  /** 工作流进度最后一次同步回本地的时间。 */
  workProgressSyncedAt: Date | null;

  packages: ReleaseDetailPackage[];
  history: ReleaseDetailHistoryRow[];
  repositoryRecords: ReleaseDetailRepositoryRecord[];
  /** 仓库记录里最近的一次同步时间；一条记录都没有时为 `null`。 */
  repositorySyncedAt: Date | null;
};

/** CRP 接口前缀去掉 `/api`，剩下的就是网页地址。 */
function crpWebOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

/**
 * CRP 网页上一个 Topic 的地址。
 *
 * 与转测申请单里写的「【CRP链接】」一致（`#/detail/detail?id=`），是 CRP 前端自己的路由。
 * 从 `CRP_BASE_URL` 推导，私有化部署换了域名也不用改代码。
 */
export function crpTopicUrl(topicId: string | null, baseUrl: string): string | null {
  if (topicId === null || topicId.trim() === "") {
    return null;
  }

  return `${crpWebOrigin(baseUrl)}/#/detail/detail?id=${encodeURIComponent(topicId)}`;
}

/** 一行快照在表里的 11 个格子，页面与 CSV 共用（`order` 是提交顺序，从 1 开始）。 */
export function snapshotRowCells(item: ReleaseDetailPackage, order: number): string[] {
  return [
    String(order),
    item.repoPath === null ? item.packageName : `${item.packageName}（${item.repoPath}）`,
    item.branch,
    item.codeVersion,
    item.repoVersion ?? "—",
    item.releaseVersion,
    item.customTag ? "是（自定义 Tag）" : "否",
    item.baselineCommit ?? "—",
    item.commitSha,
    item.commitMessage ?? "—",
    item.commitAuthor ?? "—",
  ];
}

/** Excel 会当成公式的开头字符：`= + - @`、制表符、回车。 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * 一个单元格：先挡公式注入，再按 RFC 4180 转义（含逗号、引号、换行就整格加引号，内部引号翻倍）。
 *
 * 这份文件按设计就是用 Excel 打开的（表头写 BOM 就是为了中文不乱码），而单元格的值有一部分
 * 是别人能控制的：提测版本可以是任意自定义 Tag，「提交说明」与「提交人」原样取自 Gerrit。
 * 以 `=`、`+`、`-`、`@` 开头的值在 Excel 里会被当公式执行，能把同表其他单元格的内容拼进
 * 外部链接发出去（CSV 公式注入）。
 *
 * 处理方式是给这样的值加一个前导单引号：Excel / WPS / Numbers 都把它当「这是文本」的标记，
 * 单元格里显示的还是原文。占位符「—」（U+2014）不是 ASCII 的 `-`，不会被误加。
 */
function csvCell(value: string): string {
  const guarded = FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? `'${value}`
    : value;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * 导出这条提测的快照表为 CSV。
 *
 * 表头与详情页的表头同源（`SNAPSHOT_COLUMNS`），行就是详情页上那 N 行，顺序也一样 ——
 * 「导出的内容与页面看到的一致」靠的是同一份数据与同一个铺格子的函数，不是两处各写一遍。
 *
 * 开头写 BOM：不带 BOM 的 UTF-8 在 Excel 里打开会把中文显示成乱码。
 */
export function buildSnapshotCsv(packages: readonly ReleaseDetailPackage[]): string {
  const lines = [SNAPSHOT_COLUMNS.map((column) => csvCell(column)).join(",")];

  packages.forEach((item, index) => {
    lines.push(snapshotRowCells(item, index + 1).map(csvCell).join(","));
  });

  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** 按拓扑序排序：上游在前；排不进顺序的包（理论上不会出现）按名字附在末尾。 */
function orderPackages(
  snapshots: readonly SnapshotRow[],
  upstreamByName: Map<string, string[]>,
): SnapshotRow[] {
  const entries: SoftwareEntry[] = snapshots.map((item) => ({
    packageName: item.packageName,
    trackedBranch: item.branch,
    upstreamNames: upstreamByName.get(item.packageName) ?? [],
    lastSubmittedCommit: null,
  }));
  const view = buildSoftwareView(entries);
  const byName = new Map(snapshots.map((item) => [item.packageName, item]));

  return view.order
    .map((name) => byName.get(name))
    .filter((item) => item !== undefined);
}

/** 一个提交的说明首行与作者。 */
export type GerritCommitInfo = { summary: string; authorName: string };

/** 按仓库路径与提交号读提交信息；单测传假实现，不连真实 Gerrit。 */
export type CommitInfoReader = (repoPath: string, commitSha: string) => Promise<GerritCommitInfo>;

/** 默认实现：走 A3 的 Gerrit 客户端，按当前登录用户的凭据新建，第一次真正请求时才建。 */
function defaultCommitInfoReader(): CommitInfoReader {
  let client: GerritClient | null = null;

  return async (repoPath, commitSha) => {
    client ??= await createGerritClientForCurrentUser();

    const commit = await client.getCommit(repoPath, commitSha);

    return {
      summary: (commit.message.split("\n")[0] ?? "").trim(),
      authorName: commit.author.name,
    };
  };
}

/** 提交说明与提交人；读不到就留空并记下原因，不影响整页渲染。 */
async function readCommitInfo(
  reader: CommitInfoReader | null,
  repoPath: string | null,
  commitSha: string,
): Promise<{ summary: string | null; authorName: string | null; error: string | null }> {
  if (reader === null || repoPath === null) {
    return {
      summary: null,
      authorName: null,
      error: repoPath === null ? "软件包还没登记仓库路径，读不到提交说明。" : null,
    };
  }

  try {
    return { ...(await reader(repoPath, commitSha)), error: null };
  } catch (error) {
    const message =
      error instanceof GerritError || error instanceof CredentialError
        ? error.message
        : "读取 Gerrit 提交信息失败，请稍后重试。";

    if (!(error instanceof GerritError) && !(error instanceof CredentialError)) {
      console.error(`[releases] 读取提交信息失败（${repoPath}@${commitSha}）`, error);
    }

    return { summary: null, authorName: null, error: message };
  }
}

/** 快照查询里用到的列。 */
type SnapshotRow = {
  packageName: string;
  attempt: number;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
};

export type ReleaseDetailOptions = {
  /** 替换 Gerrit 读取，单测用假实现，不连真实 Gerrit。 */
  readCommitInfo?: CommitInfoReader;
  /** 替换 CRP 客户端，单测用假实现。 */
  network?: BuildNetwork;
  /**
   * 这次读取以谁的身份调 CRP 与 Gerrit。前台传当前登录用户；不传就按当前登录用户。
   * 单测显式传，不依赖请求上下文。
   */
  actorUserId?: string;
  /** CRP 接口前缀，用来拼 Topic 地址；默认取 `CRP_BASE_URL`。 */
  crpBaseUrl?: string;
};

/**
 * 读一条提测的详情。
 *
 * 提测不存在由 `loadReleaseUpdateView` 抛 `ReleaseError`，调用方按 404 处理。
 * 跨工作区的判定不在这里做：调用方先用 `findReleaseScope` + `canViewRelease` 判一次，
 * 判不过直接 404，连这函数都不会进。
 */
export async function loadReleaseDetail(
  releaseId: string,
  options: ReleaseDetailOptions = {},
): Promise<ReleaseDetail> {
  // 能不能改、更新历史都复用 A17 的读取：锁定规则只有一份，详情页与更新页不会各说一套。
  const updateView = await loadReleaseUpdateView(releaseId, {
    network: options.network,
    actorUserId: options.actorUserId,
  });

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      version: true,
      revision: true,
      status: true,
      source: true,
      description: true,
      createdAt: true,
      crpTopicId: true,
      crpTopicState: true,
      crpTopicAbandoned: true,
      crpTopicCompleted: true,
      crpWorkProgressSyncedAt: true,
      project: {
        select: { id: true, key: true, name: true, baseline: { select: { name: true } } },
      },
      createdBy: { select: { displayName: true } },
      snapshots: {
        orderBy: [{ packageName: "asc" }, { attempt: "asc" }],
        select: {
          packageName: true,
          attempt: true,
          branch: true,
          commitSha: true,
          codeVersion: true,
          repoVersion: true,
          releaseVersion: true,
          supersededById: true,
        },
      },
      // 行序必须写死：数据库不保证无序查询的返回顺序，同一个库两次查询都可能不同。
      // 这张表直接渲染成「CRP 仓库记录」的 5 行，行序一变整页截图就跟着变。
      repositoryRecords: {
        orderBy: { snapshot: { packageName: "asc" } },
        select: {
          crpReleaseId: true,
          crpBuildId: true,
          crpStatusName: true,
          crpTag: true,
          crpBaseTag: true,
          repositoryUrl: true,
          lastSyncedAt: true,
          snapshot: { select: { packageName: true } },
        },
      },
    },
  });

  if (release === null) {
    // 与 loadReleaseUpdateView 同一口径：读不到就是不存在，按 404 交出去而不是 500。
    throw new ReleaseError("提测记录不存在。", 404);
  }

  const current = release.snapshots.filter((item) => item.supersededById === null);
  const previousCommit = previousCommits(release.snapshots);
  const names = current.map((item) => item.packageName);

  const [packages, edges] = await Promise.all([
    prisma.package.findMany({
      where: { name: { in: names } },
      select: { name: true, repoPath: true },
    }),
    prisma.packageDependency.findMany({
      where: { package: { name: { in: names } } },
      // 上游列表的顺序会影响拓扑排序在并列时的取舍，同样不能依赖数据库的返回顺序。
      orderBy: [{ package: { name: "asc" } }, { upstreamPackage: { name: "asc" } }],
      select: { package: { select: { name: true } }, upstreamPackage: { select: { name: true } } },
    }),
  ]);

  const repoPathByName = new Map(packages.map((item) => [item.name, item.repoPath]));
  const upstreamByName = new Map<string, string[]>();

  for (const edge of edges) {
    const list = upstreamByName.get(edge.package.name) ?? [];
    list.push(edge.upstreamPackage.name);
    upstreamByName.set(edge.package.name, list);
  }

  const ordered = orderPackages(current, upstreamByName);
  // 一个包都没有仓库路径时不去建 Gerrit 客户端：没配置凭据的环境照样能打开详情页。
  const reader = ordered.some((item) => repoPathByName.has(item.packageName))
    ? (options.readCommitInfo ?? defaultCommitInfoReader())
    : null;

  const commitInfos = await Promise.all(
    ordered.map((item) =>
      readCommitInfo(reader, repoPathByName.get(item.packageName) ?? null, item.commitSha),
    ),
  );

  const recordRows: ReleaseDetailRepositoryRecord[] = release.repositoryRecords.map((row) => ({
    packageName: row.snapshot.packageName,
    crpReleaseId: row.crpReleaseId,
    crpBuildId: row.crpBuildId,
    crpStatusName: row.crpStatusName,
    crpTag: row.crpTag,
    crpBaseTag: row.crpBaseTag,
    repositoryUrl: row.repositoryUrl,
    lastSyncedAt: row.lastSyncedAt,
  }));
  const packageByCrpReleaseId = new Map(
    recordRows.map((row) => [row.crpReleaseId, row.packageName]),
  );
  const crpBaseUrl = options.crpBaseUrl ?? process.env.CRP_BASE_URL?.trim() ?? CRP_DEFAULT_BASE_URL;

  return {
    releaseId: release.id,
    version: release.version,
    revision: release.revision,
    status: release.status,
    source: release.source,
    description: release.description,
    createdAt: release.createdAt,
    createdByName: release.createdBy.displayName,
    project: {
      id: release.project.id,
      key: release.project.key,
      name: release.project.name,
      baselineName: release.project.baseline.name,
    },
    lockReason: updateView.lockReason,
    workProgress: updateView.workProgress,
    workProgressLabel: updateView.workProgressLabel,
    workProgressError: updateView.workProgressError,
    crpTopicId: release.crpTopicId,
    crpTopicUrl: crpTopicUrl(release.crpTopicId, crpBaseUrl),
    crpTopicState: release.crpTopicState,
    crpTopicAbandoned: release.crpTopicAbandoned,
    crpTopicCompleted: release.crpTopicCompleted,
    workProgressSyncedAt: release.crpWorkProgressSyncedAt,
    packages: ordered.map((item, index) => ({
      packageName: item.packageName,
      repoPath: repoPathByName.get(item.packageName) ?? null,
      attempt: item.attempt,
      branch: item.branch,
      codeVersion: item.codeVersion,
      repoVersion: item.repoVersion,
      releaseVersion: item.releaseVersion,
      customTag: item.releaseVersion !== item.codeVersion,
      baselineCommit: previousCommit.get(item.packageName) ?? null,
      commitSha: item.commitSha,
      commitMessage: commitInfos[index]?.summary ?? null,
      commitAuthor: commitInfos[index]?.authorName ?? null,
      commitError: commitInfos[index]?.error ?? null,
    })),
    history: updateView.history.map((row) => ({
      ...row,
      abandonedPackages: row.abandonedCrpReleaseIds.map(
        (id) => packageByCrpReleaseId.get(id) ?? `Release ${id}`,
      ),
    })),
    repositoryRecords: recordRows,
    repositorySyncedAt: latestSync(recordRows),
  };
}

/**
 * 每个包「上一轮」的 Commit：同一提测里被替换掉的、轮次最大的那一轮。
 *
 * 显式比较 `attempt`，不依赖查询结果的排序顺序 —— 换个 orderBy 就会静默算错。
 */
function previousCommits(
  snapshots: readonly { packageName: string; attempt: number; commitSha: string; supersededById: string | null }[],
): Map<string, string> {
  const result = new Map<string, string>();
  const latestAttempt = new Map<string, number>();

  for (const item of snapshots) {
    if (item.supersededById === null) {
      continue;
    }

    const known = latestAttempt.get(item.packageName);

    if (known === undefined || item.attempt > known) {
      latestAttempt.set(item.packageName, item.attempt);
      result.set(item.packageName, item.commitSha);
    }
  }

  return result;
}

/** 仓库记录里最近一次同步时间。 */
function latestSync(rows: readonly ReleaseDetailRepositoryRecord[]): Date | null {
  let latest: Date | null = null;

  for (const row of rows) {
    if (row.lastSyncedAt !== null && (latest === null || row.lastSyncedAt > latest)) {
      latest = row.lastSyncedAt;
    }
  }

  return latest;
}
