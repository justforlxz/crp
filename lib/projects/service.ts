/**
 * 项目经理与项目的领域逻辑（数据库读写 + 业务规则）。
 *
 * 页面（`app/(app)/projects/**`、`app/(app)/managers/**`）只调这一层，规则只有一份：
 * 项目经理必须属于项目所在工作区、基线必须存在且已同步、名称与标识在工作区内唯一、
 * 复制项目不带提交历史、删项目用软删。
 *
 * 依赖边不存项目层：清单里每个包的上下游都从 `package_dependency` 反查（本文件只读它）。
 */

import { Prisma } from "../../generated/prisma/client";
import { listBaselines } from "../baselines";
import { baselineState, type BaselineState } from "../baselines/status";
import { prisma } from "../db";
import { RELEASE_TAB_STATUSES } from "../releases/list";
import { baselineBlockReason } from "./baselineGate";
import { buildSoftwareView, type SoftwareEntry, type SoftwareView } from "./softwareView";
import type { ManagerInput, ProjectInput } from "./validation";

/** 可预期的业务错误：`status` 直接对应接口状态码，`message` 原样给页面显示。 */
export class ProjectError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProjectError";
    this.status = status;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 项目卡片要的数据：基线、项目经理、清单里每个包的上游。
 *
 * 上游只取清单里这些包的，不把全平台的依赖边读进来 —— 项目卡片只关心清单内部的先后关系。
 */
const PROJECT_INCLUDE = {
  baseline: { select: { id: true, name: true, syncedAt: true } },
  projectManager: { select: { id: true, name: true } },
  software: {
    orderBy: { createdAt: "asc" },
    select: {
      trackedBranch: true,
      lastSubmittedCommit: true,
      package: {
        select: {
          id: true,
          name: true,
          repoPath: true,
          currentVersion: true,
          dependencies: { select: { upstreamPackage: { select: { name: true } } } },
        },
      },
    },
  },
} as const;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof PROJECT_INCLUDE }>;

/** 项目卡片：列表页每一行、以及详情页顶部用的都是这一份。 */
export type ProjectCard = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  manager: { id: string; name: string };
  baseline: { id: string; name: string; syncedAt: Date | null };
  updatedAt: Date;
  software: SoftwareView;
};

/**
 * 一张经理卡要的数据：`listManagers()` 的行就是它。
 *
 * 项目经理页与项目页的卡片共用这一份，两处的第二行（邮箱）与「名下项目」数因此不会一边一个样。
 */
export type ManagerCardData = {
  id: string;
  name: string;
  /** 联系邮箱；没填就是 `null`。 */
  email: string | null;
  userId: string | null;
  projectCount: number;
  /**
   * 名下项目里还在进行中的提测数。
   *
   * 不按项目的 `deletedAt` 过滤：已软删项目的提测仍会出现在提测记录页，这里与那一页保持同一
   * 范围。所以卡片上可能出现「名下项目 0 / 进行中提测 1」—— 项目删了，在跑的提测还没结束。
   */
  activeReleaseCount: number;
};

function toSoftwareEntries(row: ProjectRow): SoftwareEntry[] {
  return row.software.map((item) => ({
    packageName: item.package.name,
    trackedBranch: item.trackedBranch,
    upstreamNames: item.package.dependencies.map((edge) => edge.upstreamPackage.name),
    lastSubmittedCommit: item.lastSubmittedCommit,
  }));
}

function toCard(row: ProjectRow): ProjectCard {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    manager: { id: row.projectManager.id, name: row.projectManager.name },
    baseline: {
      id: row.baseline.id,
      name: row.baseline.name,
      syncedAt: row.baseline.syncedAt,
    },
    updatedAt: row.updatedAt,
    software: buildSoftwareView(toSoftwareEntries(row)),
  };
}

/** 工作区里的项目卡片，按名称排。软删的项目不出现。 */
export async function listProjectCards(workspaceId: string): Promise<ProjectCard[]> {
  const rows = await prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    include: PROJECT_INCLUDE,
    orderBy: { name: "asc" },
  });

  return rows.map(toCard);
}

/**
 * 项目详情：卡片数据 + 清单原始行（页面要显示仓库路径、当前版本、上次提交）。
 *
 * 软删的项目也能查到（`includeDeleted`）：历史提测记录指向它，页面得能翻出来；
 * 但列表与下拉框一律不显示。
 */
export async function getProject(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<
  | (ProjectCard & {
      workspaceId: string;
      projectManagerId: string;
      baselineId: string;
      deletedAt: Date | null;
      softwareRows: Array<{
        packageId: string;
        packageName: string;
        repoPath: string;
        currentVersion: string | null;
        trackedBranch: string;
        lastSubmittedCommit: string | null;
        upstreamNames: string[];
      }>;
    })
  | null
> {
  const row = await prisma.project.findUnique({ where: { id }, include: PROJECT_INCLUDE });

  if (row === null || (row.deletedAt !== null && options.includeDeleted !== true)) {
    return null;
  }

  return {
    ...toCard(row),
    workspaceId: row.workspaceId,
    projectManagerId: row.projectManagerId,
    baselineId: row.baselineId,
    deletedAt: row.deletedAt,
    softwareRows: row.software.map((item) => ({
      packageId: item.package.id,
      packageName: item.package.name,
      repoPath: item.package.repoPath,
      currentVersion: item.package.currentVersion,
      trackedBranch: item.trackedBranch,
      lastSubmittedCommit: item.lastSubmittedCommit,
      upstreamNames: item.package.dependencies.map((edge) => edge.upstreamPackage.name),
    })),
  };
}

/** 只要归属信息时用它：动作里先查工作区再做权限判定，不信任表单传来的工作区。 */
export function findProjectRef(
  id: string,
): Promise<{ id: string; workspaceId: string; name: string; deletedAt: Date | null } | null> {
  return prisma.project.findUnique({
    where: { id },
    select: { id: true, workspaceId: true, name: true, deletedAt: true },
  });
}

/** 项目经理的归属信息：改名之类的动作先查它再做权限判定，不信任表单传来的工作区。 */
export function findManagerRef(
  id: string,
): Promise<{ id: string; workspaceId: string; name: string } | null> {
  return prisma.projectManager.findUnique({
    where: { id },
    select: { id: true, workspaceId: true, name: true },
  });
}

/**
 * 「进行中」的提测状态：还没出结果的那几个。
 *
 * 直接取提测记录页「排队中」「构建中」两个页签覆盖的状态，两处口径只有一份。
 * 从 `lib/releases/list.ts` 直接引，不走 `lib/releases` 的 barrel —— barrel 会拉上
 * `lib/releases/service.ts`，而它反过来 import 本模块。
 */
const IN_PROGRESS_RELEASE_STATUSES = [
  ...RELEASE_TAB_STATUSES.queued,
  ...RELEASE_TAB_STATUSES.building,
] as const;

/** 工作区里的项目经理，带名下项目数（不含软删）与进行中的提测数。 */
export async function listManagers(workspaceId: string): Promise<ManagerCardData[]> {
  const managers = await prisma.projectManager.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      email: true,
      userId: true,
      _count: { select: { projects: { where: { deletedAt: null } } } },
    },
    orderBy: { name: "asc" },
  });

  // 「进行中提测」按项目经理名下项目的提测算：Prisma 的 `_count` 不能穿两层关系，
  // 所以按项目再查一次，在内存里按经理汇总。
  //
  // 这里**不**加 `deletedAt: null`：已软删项目的提测仍在提测记录页可见，两处的范围要一致。
  // 与上面「名下项目」的 `deletedAt: null` 不同是故意的 —— 一个数「还在管的项目」，
  // 一个数「还在跑的提测」，项目删了不会让在跑的提测停下。
  const projects = await prisma.project.findMany({
    where: { projectManagerId: { in: managers.map((manager) => manager.id) } },
    select: {
      projectManagerId: true,
      _count: {
        select: { releases: { where: { status: { in: [...IN_PROGRESS_RELEASE_STATUSES] } } } },
      },
    },
  });

  const activeByManager = new Map<string, number>();

  for (const project of projects) {
    activeByManager.set(
      project.projectManagerId,
      (activeByManager.get(project.projectManagerId) ?? 0) + project._count.releases,
    );
  }

  return managers.map((manager) => ({
    id: manager.id,
    name: manager.name,
    email: manager.email,
    userId: manager.userId,
    projectCount: manager._count.projects,
    activeReleaseCount: activeByManager.get(manager.id) ?? 0,
  }));
}

/**
 * 基线清单（平铺，不分类），带 A9 算出的可用状态。
 *
 * 直接复用 `lib/baselines` 的 `listBaselines()`：基线的四种状态（已消失 / 同步失败 / 已同步 /
 * 未同步）只有一处判定，项目页不再自己看 `synced_at` 猜 —— A9 合并前这里就是这么猜的，
 * 结果同一个平台两个页面对同一条基线给出相反的结论。
 */
export async function listBaselineChoices(): Promise<
  Array<{
    id: string;
    name: string;
    syncedAt: Date | null;
    state: BaselineState;
    stateLabel: string;
    latestError: string | null;
  }>
> {
  const baselines = await listBaselines();

  return baselines.map((item) => ({
    id: item.id,
    name: item.name,
    syncedAt: item.syncedAt,
    state: item.state,
    stateLabel: item.stateLabel,
    latestError: item.latestError,
  }));
}

/** 已登记软件包，供清单加包时选择。 */
export function listPackageChoices(): Promise<
  Array<{ id: string; name: string; repoPath: string; defaultBranch: string }>
> {
  return prisma.package.findMany({
    select: { id: true, name: true, repoPath: true, defaultBranch: true },
    orderBy: { name: "asc" },
  });
}

// ---------------------------------------------------------------------------
// 业务规则检查
// ---------------------------------------------------------------------------

/**
 * 项目经理必须在项目所在工作区。
 *
 * 两件事都要成立，只看其中一件都不够：
 *
 * 1. `project_manager.workspace_id` 与项目的工作区一致 —— 这是「属于这个工作区」的本体。
 * 2. 项目经理绑了平台账号时，那个账号必须是这个工作区的成员（查 `membership`）——
 *    否则项目挂在一个连工作区都进不来的人名下，权限上说不通。
 *
 * 没绑账号的项目经理（`user_id` 为空）只受第 1 条约束：先有项目经理，账号以后再说。
 */
async function assertManagerUsable(managerId: string, workspaceId: string): Promise<void> {
  const manager = await prisma.projectManager.findUnique({
    where: { id: managerId },
    select: { id: true, name: true, workspaceId: true, userId: true },
  });

  if (manager === null) {
    throw new ProjectError("项目经理不存在，请先新建项目经理。");
  }

  if (manager.workspaceId !== workspaceId) {
    throw new ProjectError(
      `项目经理「${manager.name}」不属于这个工作区，请选择本工作区的项目经理。`,
    );
  }

  if (manager.userId === null) {
    return;
  }

  const membership = await prisma.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: manager.userId } },
    select: { id: true },
  });

  if (membership === null) {
    throw new ProjectError(
      `项目经理「${manager.name}」绑定的账号还不是本工作区的成员，请先把该账号加入工作区。`,
    );
  }
}

/**
 * 基线必须存在，且状态是「已同步」。基线怎么选不限类型，也不做命名匹配。
 *
 * 状态用 A9 的 `baselineState()` 算：已消失、同步失败、未同步三种都不行。只判 `synced_at`
 * 会把「有时间戳但从 CRP 消失了」和「有时间戳但最近一次同步失败」的基线放进来。
 */
async function assertBaselineUsable(baselineId: string): Promise<void> {
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
    throw new ProjectError("基线不存在，请重新选择。");
  }

  const state = baselineState({
    missingAt: baseline.missingAt,
    syncedAt: baseline.syncedAt,
    latestRunStatus: latestRun?.status ?? null,
  });
  const reason = baselineBlockReason({ name: baseline.name, state });

  if (reason !== null) {
    throw new ProjectError(reason);
  }
}

/** 名称与标识在工作区内唯一；先查一遍是为了把冲突说得具体。 */
async function assertIdentityFree(
  workspaceId: string,
  input: Pick<ProjectInput, "name" | "key">,
  excludeId?: string,
): Promise<void> {
  const conflict = await prisma.project.findFirst({
    where: {
      workspaceId,
      OR: [{ name: input.name }, { key: input.key }],
      ...(excludeId === undefined ? {} : { NOT: { id: excludeId } }),
    },
    select: { id: true, name: true, key: true, deletedAt: true },
  });

  if (conflict === null) {
    return;
  }

  const suffix = conflict.deletedAt === null ? "" : "（该项目已删除，标识仍被它占着）";

  if (conflict.name === input.name) {
    throw new ProjectError(`这个工作区里已经有同名项目「${input.name}」${suffix}。`);
  }

  throw new ProjectError(`项目标识「${input.key}」已被占用，换一个${suffix}。`);
}

/**
 * 把唯一约束冲突（P2002）翻成与保存前查重一致的提示。
 *
 * 保存前那次 `assertIdentityFree` 挡不住「两个请求同时提交同名项目」：两边同时查不到冲突，
 * 后写的一边由数据库的唯一索引挡下。这一步如果不接住，抛上去的就是 Prisma 的原始报错。
 * 接住之后重查一次，冲突还在就说清楚是名称还是标识，已经消失就给一句通用提示。
 */
async function withIdentityConflict<T>(
  workspaceId: string,
  input: Pick<ProjectInput, "name" | "key">,
  excludeId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    try {
      await assertIdentityFree(workspaceId, input, excludeId);
    } catch (conflict) {
      if (conflict instanceof ProjectError) {
        throw conflict;
      }
      throw error;
    }

    throw new ProjectError("这个工作区里已经有同名项目或相同的项目标识，请换一个。");
  }
}

// ---------------------------------------------------------------------------
// 项目经理
// ---------------------------------------------------------------------------

/** 新建项目经理：姓名在当前工作区内唯一（数据库唯一约束兜底），邮箱可空。 */
export async function createManager(
  workspaceId: string,
  input: ManagerInput,
): Promise<{ id: string }> {
  try {
    return await prisma.projectManager.create({
      data: { workspaceId, name: input.name, email: input.email },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectError(`这个工作区里已经有叫「${input.name}」的项目经理。`);
    }
    throw error;
  }
}

/** 编辑项目经理：姓名与邮箱一起写；工作区归属与名下项目不动。 */
export async function updateManager(managerId: string, input: ManagerInput): Promise<void> {
  const manager = await prisma.projectManager.findUnique({
    where: { id: managerId },
    select: { workspaceId: true },
  });

  if (manager === null) {
    throw new ProjectError("项目经理不存在。", 404);
  }

  try {
    await prisma.projectManager.update({
      where: { id: managerId },
      data: { name: input.name, email: input.email },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectError(`这个工作区里已经有叫「${input.name}」的项目经理。`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export async function createProject(
  workspaceId: string,
  input: ProjectInput,
): Promise<{ id: string }> {
  await assertManagerUsable(input.projectManagerId, workspaceId);
  await assertBaselineUsable(input.baselineId);
  await assertIdentityFree(workspaceId, input);

  return withIdentityConflict(workspaceId, input, undefined, () =>
    prisma.project.create({
      data: {
        workspaceId,
        name: input.name,
        key: input.key,
        projectManagerId: input.projectManagerId,
        baselineId: input.baselineId,
        description: input.description,
      },
      select: { id: true },
    }),
  );
}

export async function updateProject(projectId: string, input: ProjectInput): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deletedAt: true },
  });

  if (project === null) {
    throw new ProjectError("项目不存在。", 404);
  }

  if (project.deletedAt !== null) {
    throw new ProjectError("项目已删除，不能再编辑。", 404);
  }

  await assertManagerUsable(input.projectManagerId, project.workspaceId);
  await assertBaselineUsable(input.baselineId);
  await assertIdentityFree(project.workspaceId, input, projectId);

  await withIdentityConflict(project.workspaceId, input, projectId, () =>
    prisma.project.update({
      where: { id: projectId },
      data: {
        name: input.name,
        key: input.key,
        projectManagerId: input.projectManagerId,
        baselineId: input.baselineId,
        description: input.description,
      },
    }),
  );
}

/**
 * 删除项目：只写 `deleted_at`，不物理删除。
 *
 * `release.project_id` 是 RESTRICT，历史提测记录、快照、构建记录都要能继续查到自己的项目，
 * 所以这里不能改成级联删除。清单行同样留着，恢复时不用重配。
 */
export async function softDeleteProject(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, deletedAt: true, name: true },
  });

  if (project === null) {
    throw new ProjectError("项目不存在。", 404);
  }

  if (project.deletedAt !== null) {
    return;
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
  });
}

/**
 * 复制项目：带走软件清单与每项的跟踪分支，不带提交历史。
 *
 * `last_submitted_commit` / `last_submitted_at` 必须置空（写死成 `null`，不复制源项目的值）：
 * 新项目还没提过测，继承源项目的提交号会让「有没有更新」的判断一开始就是错的。
 */
export async function copyProject(
  sourceProjectId: string,
  input: ProjectInput,
): Promise<{ id: string }> {
  const source = await prisma.project.findUnique({
    where: { id: sourceProjectId },
    select: {
      workspaceId: true,
      description: true,
      deletedAt: true,
      software: { select: { packageId: true, trackedBranch: true } },
    },
  });

  if (source === null || source.deletedAt !== null) {
    throw new ProjectError("要复制的项目不存在或已删除。", 404);
  }

  await assertManagerUsable(input.projectManagerId, source.workspaceId);
  await assertBaselineUsable(input.baselineId);
  await assertIdentityFree(source.workspaceId, input);

  return withIdentityConflict(source.workspaceId, input, undefined, () =>
    prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          workspaceId: source.workspaceId,
          name: input.name,
          key: input.key,
          projectManagerId: input.projectManagerId,
          baselineId: input.baselineId,
          description: input.description ?? source.description,
        },
        select: { id: true },
      });

      if (source.software.length > 0) {
        await tx.projectSoftware.createMany({
          data: source.software.map((item) => ({
            projectId: created.id,
            packageId: item.packageId,
            trackedBranch: item.trackedBranch,
          })),
        });
      }

      return created;
    }),
  );
}

// ---------------------------------------------------------------------------
// 项目软件清单
// ---------------------------------------------------------------------------

async function findSoftwareRow(projectId: string, packageId: string) {
  const row = await prisma.projectSoftware.findUnique({
    where: { projectId_packageId: { projectId, packageId } },
    select: { id: true, package: { select: { name: true } } },
  });

  if (row === null) {
    throw new ProjectError("这个软件包不在项目清单里。", 404);
  }

  return row;
}

/** 往清单里加一个包。已经在清单里的同一个包不能重复加。 */
export async function addProjectSoftware(input: {
  projectId: string;
  packageId: string;
  trackedBranch: string;
}): Promise<void> {
  const [project, pkg] = await Promise.all([
    prisma.project.findUnique({
      where: { id: input.projectId },
      select: { deletedAt: true },
    }),
    prisma.package.findUnique({
      where: { id: input.packageId },
      select: { name: true },
    }),
  ]);

  if (project === null) {
    throw new ProjectError("项目不存在。", 404);
  }

  if (project.deletedAt !== null) {
    throw new ProjectError("项目已删除，不能再改软件清单。", 404);
  }

  if (pkg === null) {
    throw new ProjectError("软件包不存在，请先从软件包页面登记。");
  }

  try {
    await prisma.projectSoftware.create({
      data: {
        projectId: input.projectId,
        packageId: input.packageId,
        trackedBranch: input.trackedBranch,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectError(`「${pkg.name}」已经在项目清单里了。`);
    }
    throw error;
  }
}

/** 从清单里移除一个包。历史提测快照按包名存，不受影响。 */
export async function removeProjectSoftware(input: {
  projectId: string;
  packageId: string;
}): Promise<void> {
  const row = await findSoftwareRow(input.projectId, input.packageId);

  await prisma.projectSoftware.delete({ where: { id: row.id } });
}

/** 改一项的跟踪分支。只动 `tracked_branch`，上次提交的 Commit 不动。 */
export async function updateProjectSoftwareBranch(input: {
  projectId: string;
  packageId: string;
  trackedBranch: string;
}): Promise<void> {
  const row = await findSoftwareRow(input.projectId, input.packageId);

  await prisma.projectSoftware.update({
    where: { id: row.id },
    data: { trackedBranch: input.trackedBranch },
  });
}
