/**
 * 验收用例的数据库夹具（MKACG-985）。
 *
 * 每条用例都要「有数据可查」，但库是共用的：种子数据不能动（别的用例、样式门禁都读它），
 * 所以这里每次建一套带前缀的独立数据 —— 工作区、经理、基线、项目、软件包、提测 —— 跑完按
 * 前缀删干净，不留半条。
 *
 * 三条约定：
 *
 * - **不碰种子数据**：所有行都带 `prefix`，清理只按前缀删；
 * - **不绕过应用层规则**（除了用例明确要求的那条）：依赖在调用方用 `dependencies()` 写，
 *   因为部分用例要造出应用层拒收的环；
 * - **字段取真实值**：`crpBranchId`、Commit、基线版本都写成能被人一眼认出的值，
 *   断言失败时「预期 108、实际 zz9-branch」这类消息直接能读。
 */

import type { EnvNeed } from "./env";
import * as dbModule from "./db";

/** 提测状态的可选值，与 `schema.prisma` 的 `ReleaseStatus` 一致。 */
export type ReleaseStatusName =
  | "pending"
  | "dispatching"
  | "building"
  | "success"
  | "partial_failure"
  | "failed"
  | "abandoned";

/** 快照状态的可选值，与 `schema.prisma` 的 `SnapshotStatus` 一致。 */
export type SnapshotStatusName =
  | "pending"
  | "dispatching"
  | "building"
  | "success"
  | "failed"
  | "abandoned"
  | "superseded";

/** 提测来源。 */
export type ReleaseSourceName = "platform" | "imported";

/** 建一条快照（一轮里一个包）需要的字段；没给的一律按「第 1 轮、成功」之外的普通值填。 */
export type FixtureSnapshotInput = {
  packageName: string;
  branch?: string;
  commitSha?: string;
  codeVersion?: string;
  repoVersion?: string | null;
  releaseVersion?: string;
  status?: SnapshotStatusName;
  attempt?: number;
};

/** 建一条提测需要的字段。 */
export type FixtureReleaseInput = {
  projectId: string;
  version: string;
  status?: ReleaseStatusName;
  revision?: number;
  source?: ReleaseSourceName;
  description?: string | null;
  crpTopicId?: string | null;
  createdAt?: Date;
  snapshots?: readonly FixtureSnapshotInput[];
};

/** 一套独立数据 + 建/删方法。 */
export type Fixture = {
  prefix: string;
  workspaceId: string;
  userId: string;
  managerId: string;
  baselineId: string;
  /** 建项目；`managerId` / `baselineId` 不给就用这套夹具自己的。 */
  project(input: {
    key: string;
    name: string;
    managerId?: string;
    baselineId?: string;
    deletedAt?: Date;
  }): Promise<string>;
  /** 建软件包（全局唯一表，按前缀命名）。 */
  package(input: {
    name: string;
    crpProjectName?: string | null;
    repoPath?: string;
    defaultBranch?: string;
  }): Promise<string>;
  /** 把包加进项目清单。 */
  addSoftware(
    projectId: string,
    packageId: string,
    options?: { trackedBranch?: string; lastSubmittedCommit?: string | null },
  ): Promise<void>;
  /** 写依赖：`packageId` 依赖 `upstreamPackageIds` 里的每一个。 */
  dependencies(packageId: string, upstreamPackageIds: readonly string[]): Promise<void>;
  /** 建提测（可带一批快照）。 */
  release(input: FixtureReleaseInput): Promise<string>;
  /** 按前缀删掉这套数据，包括它引出的全部子行。 */
  cleanup(): Promise<void>;
};

/** 夹具占用的环境。用例注册时用它，缺库就整条 skip。 */
export const FIXTURE_ENV: readonly EnvNeed[] = ["database"];

/**
 * 按前缀删掉一整套数据。
 *
 * 新建前也调一次：上一次跑到一半失败（断言失败、Ctrl-C、库被重置）会留下同前缀的行，
 * 而工作区 slug、用户邮箱、包名都是唯一键 —— 不清掉就会以「唯一约束冲突」的形式失败，
 * 看起来像用例写错了。删除顺序按外键依赖来，先子后父。
 */
async function purge(prefix: string): Promise<void> {
  const prisma = await dbModule.db();
  const workspaceSlug = `${prefix}-ws`;

  const workspaces = await prisma.workspace.findMany({
    where: { slug: workspaceSlug },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((row) => row.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  const projectIds = projects.map((row) => row.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((row) => row.id);

  const packages = await prisma.package.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const packageIds = packages.map((row) => row.id);

  const tasks = await prisma.buildTask.findMany({
    where: { releaseId: { in: releaseIds } },
    select: { id: true },
  });

  await prisma.buildJob.deleteMany({
    where: { buildTaskId: { in: tasks.map((row) => row.id) } },
  });
  await prisma.buildTask.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.buildPollEvent.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });

  // `superseded_by_id` 是指向同一张表的外键：先清列，再删行，否则顺序随便挑都会撞约束。
  await prisma.releasePackageSnapshot.updateMany({
    where: { releaseId: { in: releaseIds } },
    data: { supersededById: null },
  });
  await prisma.releasePackageSnapshot.deleteMany({
    where: { releaseId: { in: releaseIds } },
  });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.packageDependency.deleteMany({
    where: { OR: [{ packageId: { in: packageIds } }, { upstreamPackageId: { in: packageIds } }] },
  });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });

  const baselines = await prisma.baseline.findMany({
    where: { crpBranchId: { startsWith: prefix } },
    select: { id: true },
  });
  const baselineIds = baselines.map((row) => row.id);

  await prisma.baselinePackageVersion.deleteMany({
    where: { baselineId: { in: baselineIds } },
  });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });
  await prisma.projectManager.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: prefix } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  await prisma.package.deleteMany({ where: { id: { in: packageIds } } });
}

/**
 * 建一套独立数据。
 *
 * `prefix` 要短且唯一（例如 `zza985d`）：它同时是工作区 slug、经理名、项目 key、包名与
 * CRP 分支 ID 的前缀，清理时就靠它认人。
 */
export async function createFixture(prefix: string): Promise<Fixture> {
  const prisma = await dbModule.db();
  const workspaceSlug = `${prefix}-ws`;

  // 上一次失败留下的同前缀行会撞唯一键，先清掉。
  await purge(prefix);

  const user = await prisma.user.create({
    data: {
      email: `${prefix}@acceptance.test`,
      passwordHash: "acceptance-not-a-real-hash",
      displayName: `${prefix} 验收账号`,
    },
    select: { id: true },
  });

  const workspace = await prisma.workspace.create({
    data: { slug: workspaceSlug, name: `${prefix} 工作区` },
    select: { id: true },
  });

  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: `${prefix} 经理` },
    select: { id: true },
  });

  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: `${prefix}-branch`,
      name: `${prefix}-baseline`,
      syncedAt: new Date("2026-11-20T00:00:00Z"),
      arches: ["amd64", "arm64"],
    },
    select: { id: true },
  });

  const fixture: Fixture = {
    prefix,
    workspaceId: workspace.id,
    userId: user.id,
    managerId: manager.id,
    baselineId: baseline.id,

    async project(input) {
      const created = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          projectManagerId: input.managerId ?? manager.id,
          baselineId: input.baselineId ?? baseline.id,
          key: input.key,
          name: input.name,
          deletedAt: input.deletedAt ?? null,
        },
        select: { id: true },
      });

      return created.id;
    },

    async package(input) {
      const created = await prisma.package.create({
        data: {
          name: input.name,
          repoPath: input.repoPath ?? `acceptance/${input.name}`,
          crpProjectName: input.crpProjectName ?? null,
          defaultBranch: input.defaultBranch ?? "develop/eagle",
        },
        select: { id: true },
      });

      return created.id;
    },

    async addSoftware(projectId, packageId, options = {}) {
      await prisma.projectSoftware.create({
        data: {
          projectId,
          packageId,
          trackedBranch: options.trackedBranch ?? "develop/eagle",
          lastSubmittedCommit: options.lastSubmittedCommit ?? null,
        },
      });
    },

    async dependencies(packageId, upstreamPackageIds) {
      for (const upstreamPackageId of upstreamPackageIds) {
        await prisma.packageDependency.create({
          data: { packageId, upstreamPackageId },
        });
      }
    },

    async release(input) {
      const created = await prisma.release.create({
        data: {
          projectId: input.projectId,
          version: input.version,
          revision: input.revision ?? 1,
          status: input.status ?? "pending",
          source: input.source ?? "platform",
          description: input.description ?? null,
          crpTopicId: input.crpTopicId ?? null,
          crpBranchId: `${prefix}-branch`,
          createdById: user.id,
          createdAt: input.createdAt ?? new Date("2026-11-20T00:00:00Z"),
        },
        select: { id: true },
      });

      for (const snapshot of input.snapshots ?? []) {
        await prisma.releasePackageSnapshot.create({
          data: {
            releaseId: created.id,
            packageName: snapshot.packageName,
            attempt: snapshot.attempt ?? 1,
            branch: snapshot.branch ?? "develop/eagle",
            commitSha: snapshot.commitSha ?? `${prefix}-commit`,
            codeVersion: snapshot.codeVersion ?? "1.0.0-1",
            repoVersion: snapshot.repoVersion ?? null,
            releaseVersion: snapshot.releaseVersion ?? snapshot.codeVersion ?? "1.0.0-1",
            status: snapshot.status ?? "pending",
          },
        });
      }

      return created.id;
    },

    async cleanup() {
      await purge(prefix);
    },
  };

  return fixture;
}
