/**
 * 创建提测的领域逻辑（数据库读写 + 业务规则）。
 *
 * 页面（`app/(app)/releases/new/**`）与接口（`POST /api/releases`）只调这一层，
 * 规则只有一份：
 *
 * - 阻断条件（无软件清单、依赖有环、基线未同步）由 `plan.ts` 判定，接口再拦一次；
 * - 提测的软件包必须与项目清单完全一致，不多不少；
 * - 快照只插入，不提供任何更新入口（MUST 不原地修改）；
 * - 提测版本取自定义 Tag，没填就用 changelog 解析出的代码版本；
 * - 创建成功后把每个软件包的 `lastSubmittedCommit` 更新为本次 Commit。
 *
 * 代码版本一律在服务端从 Gerrit 现读，不采信请求体里的值：快照是审计记录，
 * 客户端传什么就存什么，等于把审计结论交给调用方。
 */

import { Prisma } from "../../generated/prisma/client";
import { getBaselineVersion, listBaselines } from "../baselines";
import { baselineState, BASELINE_STATE_LABELS, type BaselineState } from "../baselines/status";
import { prisma } from "../db";
import { GerritError } from "../integrations/gerrit";
import { listProjectCards, getProject } from "../projects";
import type { SoftwareEntry } from "../projects/softwareView";
import { emitEvent } from "../webhook";
import { createGerritReader, type GerritReader } from "./gerrit";
import {
  evaluateReleaseReadiness,
  summarizeChanges,
  type ReleaseBlocker,
  type ReleaseChangeSummary,
  type ReleaseReadiness,
} from "./plan";
import { buildSnapshotPlan, type SnapshotPlan } from "./snapshot";
import { comparePackageSet, type ReleaseInput } from "./validation";

/** 可预期的业务错误：`status` 直接对应接口状态码，`message` 原样给页面显示。 */
export class ReleaseError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReleaseError";
    this.status = status;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 第一步「选项目经理 → 选其名下项目」用的一行。 */
export type ReleaseProjectChoice = {
  id: string;
  key: string;
  name: string;
  managerId: string;
  managerName: string;
  baseline: { id: string; name: string; state: BaselineState; stateLabel: string };
  /** 清单里的软件包数。 */
  packageCount: number;
  /** 清单内部的依赖边数。 */
  dependencyCount: number;
  /** 上游在前的投递顺序。 */
  order: string[];
  /** 三项阻断条件全部不成立。 */
  ready: boolean;
  blockers: ReleaseBlocker[];
};

/** 项目清单里的一行，创建提测时按包名对应。 */
export type ReleaseProjectPackage = {
  packageId: string;
  packageName: string;
  repoPath: string;
  trackedBranch: string;
  lastSubmittedCommit: string | null;
};

/** 创建提测要用的项目全貌。 */
export type ReleaseProjectDetail = {
  id: string;
  key: string;
  name: string;
  workspaceId: string;
  deletedAt: Date | null;
  baseline: { id: string; name: string; state: BaselineState };
  packages: ReleaseProjectPackage[];
  readiness: ReleaseReadiness;
};

/** 基线的名称与可用状态。基线不存在时抛 404，与「项目不存在」同一个响应。 */
async function readBaselineState(
  baselineId: string,
): Promise<{ id: string; name: string; state: BaselineState }> {
  const [baseline, latestRun] = await Promise.all([
    prisma.baseline.findUnique({
      where: { id: baselineId },
      select: { id: true, name: true, syncedAt: true, missingAt: true },
    }),
    prisma.syncRun.findFirst({
      where: { kind: "baseline_packages", targetId: baselineId },
      orderBy: { startedAt: "desc" },
      select: { status: true },
    }),
  ]);

  if (baseline === null) {
    throw new ReleaseError("项目绑定的 CRP 基线不存在，请重新选择项目。", 404);
  }

  return {
    id: baseline.id,
    name: baseline.name,
    state: baselineState({
      missingAt: baseline.missingAt,
      syncedAt: baseline.syncedAt,
      latestRunStatus: latestRun?.status ?? null,
    }),
  };
}

/**
 * 工作区里可提测的项目，带阻断结论。
 *
 * 基线的四种状态直接复用 A9 的 `listBaselines()`：同一个平台里「这条基线能不能用」
 * 只有一处判定，项目页、提测页不会给出相反结论。
 */
export async function listReleaseProjectChoices(
  workspaceId: string,
): Promise<ReleaseProjectChoice[]> {
  const [cards, baselines] = await Promise.all([
    listProjectCards(workspaceId),
    listBaselines(),
  ]);
  const stateById = new Map(baselines.map((baseline) => [baseline.id, baseline.state]));

  return cards.map((card) => {
    const state = stateById.get(card.baseline.id) ?? "unsynced";
    const readiness = evaluateReleaseReadiness({
      baseline: { name: card.baseline.name, state },
      entries: card.software.entries,
    });

    return {
      id: card.id,
      key: card.key,
      name: card.name,
      managerId: card.manager.id,
      managerName: card.manager.name,
      baseline: {
        id: card.baseline.id,
        name: card.baseline.name,
        state,
        stateLabel: BASELINE_STATE_LABELS[state],
      },
      packageCount: readiness.packageCount,
      dependencyCount: readiness.dependencyCount,
      order: readiness.order,
      ready: readiness.ready,
      blockers: readiness.blockers,
    };
  });
}

/**
 * 项目全貌：基线状态、清单、阻断结论。
 *
 * 项目不存在返回 `null`，由调用方决定 404 还是别的响应；已删除的项目照常返回，
 * 由调用方拒绝 —— 历史提测记录还要能查到它。
 */
export async function loadReleaseProject(
  projectId: string,
): Promise<ReleaseProjectDetail | null> {
  const project = await getProject(projectId, { includeDeleted: true });

  if (project === null) {
    return null;
  }

  const baseline = await readBaselineState(project.baselineId);
  const entries: SoftwareEntry[] = project.softwareRows.map((row) => ({
    packageName: row.packageName,
    trackedBranch: row.trackedBranch,
    upstreamNames: row.upstreamNames,
    lastSubmittedCommit: row.lastSubmittedCommit,
  }));

  return {
    id: project.id,
    key: project.key,
    name: project.name,
    workspaceId: project.workspaceId,
    deletedAt: project.deletedAt,
    baseline,
    packages: project.softwareRows.map((row) => ({
      packageId: row.packageId,
      packageName: row.packageName,
      repoPath: row.repoPath,
      trackedBranch: row.trackedBranch,
      lastSubmittedCommit: row.lastSubmittedCommit,
    })),
    readiness: evaluateReleaseReadiness({ baseline, entries }),
  };
}

/** 只要归属信息时用它：接口先查工作区再做权限判定，不信任请求体里传来的工作区。 */
export function findReleaseProjectRef(
  projectId: string,
): Promise<{ id: string; workspaceId: string; name: string; deletedAt: Date | null } | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, name: true, deletedAt: true },
  });
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

/** 创建提测的选项。 */
export type CreateReleaseOptions = {
  /** 发起人，取自会话。 */
  createdById: string;
  /** 读代码版本用；单测注入假实现，生产代码不传，按环境变量建 Gerrit 客户端。 */
  reader?: Pick<GerritReader, "readCodeVersion">;
};

/** 创建成功后的结果，页面与接口都用它显示「建了几条快照、顺序是什么」。 */
export type CreatedRelease = {
  id: string;
  version: string;
  revision: number;
  /** 按投递顺序排好的快照。 */
  snapshots: SnapshotPlan[];
  /** 投递顺序（上游在前），与快照顺序一致。 */
  order: string[];
  summary: ReleaseChangeSummary;
};

/** 把 Gerrit 的失败翻成能显示的话，并指出是哪个包读不出来。 */
function toReleaseError(error: unknown, packageName: string): ReleaseError {
  if (error instanceof ReleaseError) {
    return error;
  }

  if (error instanceof GerritError) {
    return new ReleaseError(
      `读取「${packageName}」的代码版本失败：${error.message}`,
      502,
    );
  }

  console.error(`[releases] 读取 ${packageName} 的代码版本失败`, error);
  return new ReleaseError(`读取「${packageName}」的代码版本失败，请稍后重试。`, 502);
}

/**
 * 项目能不能建提测：存在、没删、三条阻断条件都不成立。
 *
 * 阻断条件本身由 `plan.ts` 判定，这里只把结论翻成 404/409 与可读的话。
 * 「项目不存在」与「项目已删除」都给 404：已删除的项目不该因为「存在过」而泄露出去。
 */
function assertProjectUsable(project: ReleaseProjectDetail | null): ReleaseProjectDetail {
  if (project === null) {
    throw new ReleaseError("项目不存在。", 404);
  }

  if (project.deletedAt !== null) {
    throw new ReleaseError("项目已删除，不能再创建提测。历史提测记录仍可查看。", 404);
  }

  if (!project.readiness.ready) {
    throw new ReleaseError(
      project.readiness.blockers.map((blocker) => blocker.message).join("；"),
      409,
    );
  }

  return project;
}

/**
 * 提交的软件包必须与项目清单完全一致：不多、不少、不重复。
 *
 * MUST NOT 在清单外加包，MUST 清单内全部软件都进提测（「无变化」也不例外）。
 */
function assertPackageSetMatches(
  project: ReleaseProjectDetail,
  submitted: readonly string[],
): void {
  const set = comparePackageSet(
    project.packages.map((item) => item.packageName),
    submitted,
  );

  if (set.unexpected.length > 0) {
    throw new ReleaseError(
      `这些软件包不在项目清单里，不能提测：${set.unexpected.join("、")}。`,
    );
  }

  if (set.missing.length > 0) {
    throw new ReleaseError(
      `项目清单里的这些软件包没有进提测：${set.missing.join("、")}。` +
        "清单内全部软件都要提测，「无变化」的也不例外。",
    );
  }

  if (set.duplicated.length > 0) {
    throw new ReleaseError(`这些软件包重复提交了：${set.duplicated.join("、")}。`);
  }
}

/**
 * 按依赖拓扑顺序组装快照：代码版本从 Gerrit 现读，仓库版本取自基线缓存。
 *
 * 顺序用 `readiness.order`（上游在前），它同时决定快照的插入顺序，页面与 A12 都读这一份。
 * 代码版本不采信请求体：快照是审计记录，客户端传什么就存什么等于把审计结论交给调用方。
 */
async function collectSnapshots(
  project: ReleaseProjectDetail,
  input: ReleaseInput,
  reader: Pick<GerritReader, "readCodeVersion">,
): Promise<SnapshotPlan[]> {
  const packageByName = new Map(project.packages.map((item) => [item.packageName, item]));
  const submittedByName = new Map(input.packages.map((item) => [item.packageName, item]));
  const snapshots: SnapshotPlan[] = [];

  for (const packageName of project.readiness.order) {
    const pkg = packageByName.get(packageName);
    const submitted = submittedByName.get(packageName);

    if (pkg === undefined || submitted === undefined) {
      // 前面已经按包名比对过，走不到这里；真走到了说明清单在两次读取之间变了。
      throw new ReleaseError(`软件包「${packageName}」的清单状态已变化，请刷新后重试。`, 409);
    }

    let codeVersion: string;

    try {
      codeVersion = await reader.readCodeVersion(pkg.repoPath, submitted.commitSha);
    } catch (error) {
      throw toReleaseError(error, packageName);
    }

    snapshots.push(
      buildSnapshotPlan({
        packageName,
        branch: submitted.branch,
        commitSha: submitted.commitSha,
        codeVersion,
        repoVersion: await getBaselineVersion(project.baseline.id, packageName),
        customTag: submitted.customTag,
        lastSubmittedCommit: pkg.lastSubmittedCommit,
      }),
    );
  }

  return snapshots;
}

/**
 * 一个事务里写提测、写快照、回写提交号 —— 任何一步失败都不留下半条提测。
 *
 * 版本号重复（`(project_id, version)` 唯一）在这里翻成可读提示：保存前查重挡不住
 * 「两个请求同时提交同版本号」，唯一索引是最终裁判。
 */
async function persistRelease(
  project: ReleaseProjectDetail,
  input: ReleaseInput,
  snapshots: readonly SnapshotPlan[],
  createdById: string,
): Promise<{ id: string; version: string; revision: number }> {
  const packageByName = new Map(project.packages.map((item) => [item.packageName, item]));
  const submittedAt = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const release = await tx.release.create({
        data: {
          projectId: project.id,
          version: input.version,
          revision: 1,
          // 状态里没有 `queued`：`pending` 就是「已创建、尚未投递」。
          status: "pending",
          description: input.description,
          createdById,
        },
        select: { id: true, version: true, revision: true },
      });

      await tx.releasePackageSnapshot.createMany({
        data: snapshots.map((snapshot) => ({
          releaseId: release.id,
          packageName: snapshot.packageName,
          attempt: snapshot.attempt,
          branch: snapshot.branch,
          commitSha: snapshot.commitSha,
          codeVersion: snapshot.codeVersion,
          repoVersion: snapshot.repoVersion,
          releaseVersion: snapshot.releaseVersion,
        })),
      });

      for (const snapshot of snapshots) {
        const pkg = packageByName.get(snapshot.packageName);

        if (pkg === undefined) {
          continue;
        }

        await tx.projectSoftware.update({
          where: { projectId_packageId: { projectId: project.id, packageId: pkg.packageId } },
          data: { lastSubmittedCommit: snapshot.commitSha, lastSubmittedAt: submittedAt },
        });
      }

      return release;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReleaseError(
        `这个项目已经有版本号「${input.version}」的提测记录，换一个 Topic 版本号。`,
        409,
      );
    }

    throw error;
  }
}

/**
 * 创建一次提测：落 `Release` 与每个软件包一条快照，并回写 `lastSubmittedCommit`。
 *
 * 顺序固定，每一步都有理由：
 *
 * 1. 查项目并判定阻断条件 —— 无软件清单、依赖有环、基线未同步都不写库；
 * 2. 提交的软件包必须与清单完全一致 —— 不许多、不许少、不许重复；
 * 3. 逐个读代码版本（Gerrit）与仓库版本（基线缓存），组装快照；
 * 4. 一个事务里写提测、写快照、回写提交号；
 * 5. 事务提交后发 `release.created` 事件，投递失败不影响提测本身。
 *
 * 快照按依赖拓扑顺序插入，`attempt` 一律为 1：本节点只创建新提测，
 * 补包换包走 A17 的追加轮次，不在这里原地改。
 */
export async function createRelease(
  input: ReleaseInput,
  options: CreateReleaseOptions,
): Promise<CreatedRelease> {
  const project = assertProjectUsable(await loadReleaseProject(input.projectId));

  assertPackageSetMatches(
    project,
    input.packages.map((item) => item.packageName),
  );

  const snapshots = await collectSnapshots(
    project,
    input,
    options.reader ?? createGerritReader(),
  );
  const created = await persistRelease(project, input, snapshots, options.createdById);
  const order = snapshots.map((snapshot) => snapshot.packageName);

  await emitEvent(
    "release.created",
    {
      releaseId: created.id,
      projectId: project.id,
      projectKey: project.key,
      version: created.version,
      revision: created.revision,
      packageCount: snapshots.length,
      changedCount: snapshots.filter((snapshot) => snapshot.changed).length,
      order,
    },
    { workspaceId: project.workspaceId },
  );

  return {
    id: created.id,
    version: created.version,
    revision: created.revision,
    snapshots,
    order,
    summary: summarizeChanges(snapshots),
  };
}
