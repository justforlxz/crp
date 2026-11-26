/**
 * 软件包登记与依赖配置的领域逻辑。
 *
 * 页面（`app/(app)/packages/**`）与接口（`app/api/packages`）都走这一层，两条入口的
 * 规则因此只有一份：唯一约束怎么报错、删除前查什么、依赖成环怎么拒绝。
 *
 * 依赖只在 `package_dependency` 存一份，项目清单（`project_software`）只读引用。
 */

import { prisma } from "../db";
import { Prisma } from "../../generated/prisma/client";
import { createGerritClientForCurrentUser } from "../integrations/gerrit";
import {
  findDependencyCycle,
  formatCycle,
  type DependencyEdge,
} from "./dependencyGraph";
import { fetchPackageMetadata } from "./sync";
import type { PackageInput } from "./validation";

/** 可预期的业务错误：`status` 直接对应接口状态码。 */
export class PackageError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PackageError";
    this.status = status;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** 详情页「查某个基线的仓库版本」用到的基线选项。 */
export function listBaselineOptions() {
  return prisma.baseline.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
/** 列表：软件包与它被多少项目引用、有多少上下游。 */
export function listPackages() {
  return prisma.package.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: { dependencies: true, dependents: true, projectSoftware: true },
      },
    },
  });
}

/** 详情：基础信息 + 上游依赖 + 谁依赖它 + 哪些项目引用 + 各基线里的仓库版本。 */
export async function getPackageDetail(id: string) {
  const pkg = await prisma.package.findUnique({
    where: { id },
    include: {
      dependencies: {
        orderBy: { createdAt: "asc" },
        include: {
          upstreamPackage: {
            select: { id: true, name: true, repoPath: true, currentVersion: true },
          },
        },
      },
      dependents: {
        orderBy: { createdAt: "asc" },
        include: { package: { select: { id: true, name: true } } },
      },
      projectSoftware: {
        orderBy: { createdAt: "asc" },
        include: {
          project: {
            select: { id: true, key: true, name: true, deletedAt: true },
          },
        },
      },
    },
  });

  if (!pkg) {
    return null;
  }

  const baselineVersions = await prisma.baselinePackageVersion.findMany({
    where: { packageName: pkg.name },
    orderBy: { baseline: { name: "asc" } },
    include: { baseline: { select: { id: true, name: true } } },
  });

  return { ...pkg, baselineVersions };
}

/**
 * 唯一性检查。
 *
 * `name` 与 `repoPath` 各自唯一，重复时间点不同（同名 / 同仓库两条信息），
 * 报错要能分别讲清楚，所以先查一遍而不是只靠数据库的 P2002。
 */
async function assertNoConflict(input: PackageInput, excludeId?: string) {
  const conflict = await prisma.package.findFirst({
    where: {
      OR: [{ name: input.name }, { repoPath: input.repoPath }],
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { name: true, repoPath: true },
  });

  if (!conflict) {
    return;
  }

  if (conflict.name === input.name) {
    throw new PackageError(
      `已存在同名软件包 ${input.name}（仓库 ${conflict.repoPath}）。`,
      409,
    );
  }

  throw new PackageError(
    `仓库路径 ${input.repoPath} 已被软件包 ${conflict.name} 使用。`,
    409,
  );
}

/**
 * 编辑时要写的字段。
 *
 * 换了仓库或默认分支，旧的 Commit 与版本就不属于新分支了：清空它们与同步时间，
 * 让页面显示「未同步」，而不是继续展示上一分支的数据骗人。
 *
 * `crpProjectName` 是纯配置：改它只影响投递时查哪个 CRP 项目，不碰已同步的 Commit 与版本，
 * 也不影响已经投出去的 Release。
 */
function fieldsForUpdate(
  input: PackageInput,
  current: { repoPath: string; defaultBranch: string },
): Prisma.PackageUpdateInput {
  const branchChanged =
    input.repoPath !== current.repoPath ||
    input.defaultBranch !== current.defaultBranch;

  const data: Prisma.PackageUpdateInput = {
    name: input.name,
    repoPath: input.repoPath,
    defaultBranch: input.defaultBranch,
    currentVersion: input.currentVersion,
    crpProjectName: input.crpProjectName,
  };

  if (branchChanged) {
    data.currentCommit = null;
    data.lastSyncedAt = null;
  }

  return data;
}

export async function createPackage(input: PackageInput) {
  await assertNoConflict(input);

  try {
    return await prisma.package.create({ data: { ...input } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PackageError(
        `软件包 ${input.name} 或仓库 ${input.repoPath} 已被登记。`,
        409,
      );
    }
    throw error;
  }
}

export async function updatePackage(id: string, input: PackageInput) {
  const current = await prisma.package.findUnique({
    where: { id },
    select: { id: true, repoPath: true, defaultBranch: true },
  });

  if (!current) {
    throw new PackageError("软件包不存在。", 404);
  }

  await assertNoConflict(input, id);

  try {
    return await prisma.package.update({
      where: { id },
      data: fieldsForUpdate(input, current),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PackageError(
        `软件包 ${input.name} 或仓库 ${input.repoPath} 已被登记。`,
        409,
      );
    }
    throw error;
  }
}

/**
 * 删除。
 *
 * 三条前置条件缺一不可，全部在第一句 SQL 之前查清：
 * 被项目引用不能删（正文 MUST NOT）、被别的软件包依赖不能删（依赖链会断在半路）。
 * 自己配置的上游依赖随包一起清掉，它们离开这个包就没有意义。
 */
export async function deletePackage(id: string) {
  const pkg = await prisma.package.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      _count: { select: { projectSoftware: true, dependents: true } },
    },
  });

  if (!pkg) {
    throw new PackageError("软件包不存在。", 404);
  }

  if (pkg._count.projectSoftware > 0) {
    throw new PackageError(
      `软件包 ${pkg.name} 仍被 ${pkg._count.projectSoftware} 个项目引用，不能删除。请先从项目软件清单里移除。`,
      409,
    );
  }

  if (pkg._count.dependents > 0) {
    throw new PackageError(
      `软件包 ${pkg.name} 仍被 ${pkg._count.dependents} 个软件包依赖，不能删除。请先解除这些依赖。`,
      409,
    );
  }

  await prisma.$transaction([
    prisma.packageDependency.deleteMany({ where: { packageId: id } }),
    prisma.package.delete({ where: { id } }),
  ]);
}

/**
 * 保存一个软件包的上游依赖（整体替换）。
 *
 * 环检测在写库之前做，用的是「全库依赖 + 本次要写入的边」组成的完整图：
 * 只看本包自己的边，B→C→A 这种已经在库里形成的回路就漏了。
 * 检出环就整次拒绝，库里一行不改。
 */
export async function saveDependencies(
  packageId: string,
  upstreamPackageIds: readonly string[],
) {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    select: { id: true, name: true },
  });

  if (!pkg) {
    throw new PackageError("软件包不存在。", 404);
  }

  const wanted = [...new Set(upstreamPackageIds)];
  const packages = await prisma.package.findMany({
    select: { id: true, name: true },
  });
  const nameById = new Map(packages.map((item) => [item.id, item.name]));

  const missing = wanted.filter((id) => !nameById.has(id));
  if (missing.length > 0) {
    throw new PackageError(
      `依赖里有不存在的软件包：${missing.join("、")}。`,
      400,
    );
  }

  const existing = await prisma.packageDependency.findMany({
    select: { packageId: true, upstreamPackageId: true },
  });

  const edges: DependencyEdge[] = existing
    .filter((edge) => edge.packageId !== packageId)
    .map((edge) => ({
      from: nameById.get(edge.packageId) ?? edge.packageId,
      to: nameById.get(edge.upstreamPackageId) ?? edge.upstreamPackageId,
    }));

  for (const upstreamId of wanted) {
    edges.push({
      from: pkg.name,
      to: nameById.get(upstreamId) ?? upstreamId,
    });
  }

  const cycle = findDependencyCycle(edges);
  if (cycle) {
    throw new PackageError(
      `依赖成环，已拒绝保存：${formatCycle(cycle)}。请调整上游依赖后重试。`,
      400,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.packageDependency.deleteMany({ where: { packageId } });

    if (wanted.length > 0) {
      await tx.packageDependency.createMany({
        data: wanted.map((upstreamPackageId) => ({
          packageId,
          upstreamPackageId,
        })),
      });
    }
  });
}

/** 一个软件包的仓库版本查询与元数据同步，见 `sync.ts`。 */
export type UpsertResult = {
  /** 本次新建的包名。 */
  created: string[];
  /** 本次按同名覆盖更新的包名。 */
  updated: string[];
};

/**
 * `POST /api/packages` 的落库动作：按名称幂等 —— 同名包更新，不重复插入。
 *
 * 整批放在同一个事务里：只要有一条冲突，整批回滚，不留半批数据。
 */
export async function upsertPackages(
  inputs: readonly PackageInput[],
): Promise<UpsertResult> {
  return prisma.$transaction(async (tx) => {
    const result: UpsertResult = { created: [], updated: [] };

    for (const input of inputs) {
      const existing = await tx.package.findUnique({
        where: { name: input.name },
        select: { id: true, repoPath: true, defaultBranch: true },
      });

      const repoTaken = await tx.package.findUnique({
        where: { repoPath: input.repoPath },
        select: { id: true, name: true },
      });

      if (repoTaken && repoTaken.id !== existing?.id) {
        throw new PackageError(
          `仓库路径 ${input.repoPath} 已被软件包 ${repoTaken.name} 使用。`,
          409,
        );
      }

      if (existing) {
        await tx.package.update({
          where: { id: existing.id },
          data: fieldsForUpdate(input, existing),
        });
        result.updated.push(input.name);
      } else {
        await tx.package.create({ data: { ...input } });
        result.created.push(input.name);
      }
    }

    return result;
  });
}

/**
 * 从 Gerrit 同步一个软件包的元数据并落库。
 *
 * `lastSyncedAt` 只在这一步成功之后写：同步失败时它的值仍然是上一次成功的时间，
 * 页面能看出「多久没同步成功过」。
 */
export async function syncPackageMetadata(id: string) {
  const pkg = await prisma.package.findUnique({
    where: { id },
    select: { id: true, repoPath: true, defaultBranch: true },
  });

  if (!pkg) {
    throw new PackageError("软件包不存在。", 404);
  }

  const metadata = await fetchPackageMetadata(
    await createGerritClientForCurrentUser(),
    pkg,
  );

  return prisma.package.update({
    where: { id },
    data: {
      defaultBranch: metadata.defaultBranch,
      currentCommit: metadata.currentCommit,
      currentVersion: metadata.currentVersion,
      lastSyncedAt: new Date(),
    },
  });
}
