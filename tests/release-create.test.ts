/**
 * 创建提测的集成测试：真连数据库跑一遍。
 *
 * 数据库连接串由 `DATABASE_URL` 提供（CI 的服务容器或本机 `.env`），迁移由 `pnpm db:migrate` 先行执行；
 * 本文件建的库、项目、软件包一律带固定前缀，跑完自己清掉，不影响种子数据。
 *
 * 锁住的是本节点的 MUST：
 *
 * - 清单内全部软件都进快照，不因「无变化」排除（AC1）；
 * - 快照按依赖拓扑顺序写入（AC1）；
 * - 自定义 Tag 只覆盖提测版本，代码版本保持 changelog 解析值（AC3）；
 * - 创建后改项目配置，历史快照不变（AC4）；
 * - 创建成功后 `lastSubmittedCommit` 更新为本次 Commit（AC5）；
 * - 三条阻断条件在服务端生效（AC2）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { POST } from "../app/api/releases/route";
import { prisma } from "../lib/db";
import { createRelease, ReleaseError } from "../lib/releases";

const PREFIX = "zz885";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const SHA_C = "ccccccccccccccccccccccccccccccccccccccc3";

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
  unsyncedBaselineId: string;
  managerId: string;
  projectId: string;
  emptyProjectId: string;
  unsyncedProjectId: string;
  packageIds: Record<string, string>;
};

let fixture: Fixture;

/** 代码版本按提交号给出：不同提交拿到不同版本，才能证明快照记的是所选提交。 */
const reader = {
  calls: [] as Array<{ repoPath: string; commitSha: string }>,
  async readCodeVersion(repoPath: string, commitSha: string): Promise<string> {
    reader.calls.push({ repoPath, commitSha });
    return `${commitSha.slice(0, 7)}-1`;
  },
};

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

async function cleanup(): Promise<void> {
  const baselines = await prisma.baseline.findMany({
    where: { crpBranchId: { startsWith: PREFIX } },
    select: { id: true },
  });
  const baselineIds = baselines.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { baselineId: { in: baselineIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  if (releaseIds.length > 0) {
    await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });
  }

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });
  await prisma.baselinePackageVersion.deleteMany({ where: { baselineId: { in: baselineIds } } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });
  await prisma.membership.deleteMany({ where: { workspace: { slug: WORKSPACE_SLUG } } });
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE_SLUG } });

  await prisma.packageDependency.deleteMany({
    where: {
      OR: [
        { package: { name: { startsWith: PREFIX } } },
        { upstreamPackage: { name: { startsWith: PREFIX } } },
      ],
    },
  });
  await prisma.package.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

async function createPackage(suffix: string, dependencies: string[] = []): Promise<string> {
  const created = await prisma.package.create({
    data: {
      name: pkgName(suffix),
      repoPath: `${PREFIX}/${suffix}`,
      defaultBranch: "develop/eagle",
    },
    select: { id: true },
  });

  for (const upstream of dependencies) {
    await prisma.packageDependency.create({
      data: { packageId: created.id, upstreamPackageId: fixture.packageIds[upstream] },
    });
  }

  return created.id;
}

async function createProject(input: {
  key: string;
  name: string;
  baselineId: string;
  software: Array<[string, string]>;
}): Promise<string> {
  const project = await prisma.project.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectManagerId: fixture.managerId,
      baselineId: input.baselineId,
      key: input.key,
      name: input.name,
    },
    select: { id: true },
  });

  for (const [suffix, trackedBranch] of input.software) {
    await prisma.projectSoftware.create({
      data: {
        projectId: project.id,
        packageId: fixture.packageIds[suffix],
        trackedBranch,
      },
    });
  }

  return project.id;
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} 开发者`,
    },
    select: { id: true },
  });

  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: `${PREFIX}-branch`,
      name: `${PREFIX}-baseline`,
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  const unsyncedBaseline = await prisma.baseline.create({
    data: { crpBranchId: `${PREFIX}-branch-unsynced`, name: `${PREFIX}-baseline-unsynced` },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    unsyncedBaselineId: unsyncedBaseline.id,
    managerId: manager.id,
    projectId: "",
    emptyProjectId: "",
    unsyncedProjectId: "",
    packageIds: {},
  };

  // 三层依赖链：c 依赖 b，b 依赖 a。投递顺序必须是 a → b → c。
  fixture.packageIds.a = await createPackage("a");
  fixture.packageIds.b = await createPackage("b", ["a"]);
  fixture.packageIds.c = await createPackage("c", ["b"]);

  // 基线仓库里已有 a 的版本，b 与 c 查不到。
  await prisma.baselinePackageVersion.create({
    data: {
      baselineId: baseline.id,
      packageName: pkgName("a"),
      version: "0.9.0-1",
      fetchedAt: new Date("2026-11-18T00:00:00Z"),
    },
  });

  fixture.projectId = await createProject({
    key: `${PREFIX}-main`,
    name: `${PREFIX} 主项目`,
    baselineId: baseline.id,
    software: [
      ["a", "develop/eagle"],
      ["b", "develop/eagle"],
      ["c", "develop/eagle"],
    ],
  });

  fixture.emptyProjectId = await createProject({
    key: `${PREFIX}-empty`,
    name: `${PREFIX} 空清单项目`,
    baselineId: baseline.id,
    software: [],
  });

  fixture.unsyncedProjectId = await createProject({
    key: `${PREFIX}-unsynced`,
    name: `${PREFIX} 未同步基线项目`,
    baselineId: unsyncedBaseline.id,
    software: [["a", "develop/eagle"]],
  });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function releaseInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: fixture.projectId,
    version: "25.0.2",
    description: "V25 第二个提测",
    packages: [
      { packageName: pkgName("c"), branch: "develop/eagle", commitSha: SHA_C, customTag: null },
      { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
      { packageName: pkgName("b"), branch: "develop/eagle", commitSha: SHA_B, customTag: null },
    ],
    ...overrides,
  };
}

test("创建提测：三层依赖全部进快照，写入顺序与拓扑序一致（AC1）", async () => {
  reader.calls.length = 0;

  const created = await createRelease(releaseInput(), {
    createdById: fixture.userId,
    reader,
  });

  assert.equal(created.version, "25.0.2");
  assert.equal(created.revision, 1);
  assert.deepEqual(created.order, [pkgName("a"), pkgName("b"), pkgName("c")]);
  assert.equal(created.snapshots.length, 3);
  assert.equal(created.summary.changed, 3);

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: created.id },
    select: { status: true, revision: true, description: true, createdById: true, projectId: true },
  });

  assert.equal(release.status, "pending");
  assert.equal(release.revision, 1);
  assert.equal(release.description, "V25 第二个提测");
  assert.equal(release.createdById, fixture.userId);
  assert.equal(release.projectId, fixture.projectId);

  // 快照表没有「顺序」列：顺序由 `created.order`（依赖拓扑序）给出，A12 按它投递。
  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId: created.id },
    orderBy: { packageName: "asc" },
    select: {
      packageName: true,
      attempt: true,
      branch: true,
      commitSha: true,
      codeVersion: true,
      repoVersion: true,
      releaseVersion: true,
      status: true,
    },
  });

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.packageName),
    [pkgName("a"), pkgName("b"), pkgName("c")],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.attempt),
    [1, 1, 1],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.commitSha),
    [SHA_A, SHA_B, SHA_C],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.codeVersion),
    [`${SHA_A.slice(0, 7)}-1`, `${SHA_B.slice(0, 7)}-1`, `${SHA_C.slice(0, 7)}-1`],
  );
  // 基线缓存里只有 a 的版本，b 与 c 查不到就是空。
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.repoVersion),
    ["0.9.0-1", null, null],
  );
  // 没填自定义 Tag 时提测版本等于代码版本。
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.releaseVersion),
    snapshots.map((snapshot) => snapshot.codeVersion),
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.status),
    ["pending", "pending", "pending"],
  );

  // 每个包都按自己的仓库路径读代码版本，没有串包。
  assert.deepEqual(
    reader.calls.map((call) => call.repoPath),
    [`${PREFIX}/a`, `${PREFIX}/b`, `${PREFIX}/c`],
  );
});

test("创建成功后 lastSubmittedCommit 更新为本次 Commit（AC5）", async () => {
  const rows = await prisma.projectSoftware.findMany({
    where: { projectId: fixture.projectId },
    select: { package: { select: { name: true } }, lastSubmittedCommit: true, lastSubmittedAt: true },
  });
  const byName = new Map(rows.map((row) => [row.package.name, row]));

  assert.equal(byName.get(pkgName("a"))?.lastSubmittedCommit, SHA_A);
  assert.equal(byName.get(pkgName("b"))?.lastSubmittedCommit, SHA_B);
  assert.equal(byName.get(pkgName("c"))?.lastSubmittedCommit, SHA_C);
  assert.ok(byName.get(pkgName("a"))?.lastSubmittedAt instanceof Date);
});

test("自定义 Tag 只覆盖提测版本，代码版本保持 changelog 解析值（AC3）", async () => {
  const created = await createRelease(
    releaseInput({
      version: "25.0.3",
      packages: [
        { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: "9.9.9" },
        { packageName: pkgName("b"), branch: "develop/eagle", commitSha: SHA_B, customTag: null },
        { packageName: pkgName("c"), branch: "develop/eagle", commitSha: SHA_C, customTag: null },
      ],
    }),
    { createdById: fixture.userId, reader },
  );

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId: created.id },
    select: { packageName: true, codeVersion: true, releaseVersion: true, repoVersion: true },
  });
  const a = snapshots.find((snapshot) => snapshot.packageName === pkgName("a"));

  assert.ok(a !== undefined);
  assert.equal(a.releaseVersion, "9.9.9");
  assert.equal(a.codeVersion, `${SHA_A.slice(0, 7)}-1`);
  assert.equal(a.repoVersion, "0.9.0-1");
});

test("创建后改项目跟踪分支，历史快照不变（AC4）", async () => {
  const created = await createRelease(
    releaseInput({
      version: "25.0.4",
      packages: [
        { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
        { packageName: pkgName("b"), branch: "develop/eagle", commitSha: SHA_B, customTag: null },
        { packageName: pkgName("c"), branch: "develop/eagle", commitSha: SHA_C, customTag: null },
      ],
    }),
    { createdById: fixture.userId, reader },
  );

  const before = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId: created.id },
    orderBy: { packageName: "asc" },
    select: { packageName: true, branch: true, commitSha: true, codeVersion: true },
  });

  // 改项目清单的跟踪分支：快照是审计记录，不能被项目配置改动带跑。
  await prisma.projectSoftware.updateMany({
    where: { projectId: fixture.projectId },
    data: { trackedBranch: "develop/master" },
  });

  const afterChange = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId: created.id },
    orderBy: { packageName: "asc" },
    select: { packageName: true, branch: true, commitSha: true, codeVersion: true },
  });

  assert.deepEqual(afterChange, before);
  assert.deepEqual(
    afterChange.map((snapshot) => snapshot.branch),
    ["develop/eagle", "develop/eagle", "develop/eagle"],
  );

  // 复原，后面的用例还要用跟踪分支。
  await prisma.projectSoftware.updateMany({
    where: { projectId: fixture.projectId },
    data: { trackedBranch: "develop/eagle" },
  });
});

test("基线未同步时被阻断，一行都不写（AC2）", async () => {
  const before = await prisma.release.count({ where: { projectId: fixture.unsyncedProjectId } });

  await assert.rejects(
    createRelease(
      releaseInput({
        projectId: fixture.unsyncedProjectId,
        version: "25.1.0",
        packages: [
          { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
        ],
      }),
      { createdById: fixture.userId, reader },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /还没有同步过/);
      return true;
    },
  );

  assert.equal(await prisma.release.count({ where: { projectId: fixture.unsyncedProjectId } }), before);
});

test("清单为空时被阻断，并指出去哪里加包（AC2）", async () => {
  await assert.rejects(
    createRelease(
      releaseInput({ projectId: fixture.emptyProjectId, version: "25.1.1", packages: [] }),
      { createdById: fixture.userId, reader },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /软件清单/);
      return true;
    },
  );
});

test("清单外的软件包不能提测", async () => {
  await assert.rejects(
    createRelease(
      releaseInput({
        version: "25.1.3",
        packages: [
          { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
          { packageName: pkgName("b"), branch: "develop/eagle", commitSha: SHA_B, customTag: null },
          { packageName: pkgName("c"), branch: "develop/eagle", commitSha: SHA_C, customTag: null },
          // d 这个包已登记，但不在这个项目的清单里。
          {
            packageName: pkgName("d"),
            branch: "develop/eagle",
            commitSha: "ddddddddddddddddddddddddddddddddddddddd4",
            customTag: null,
          },
        ],
      }),
      { createdById: fixture.userId, reader },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 400);
      assert.match(error.message, /不在项目清单里/);
      return true;
    },
  );
});

test("清单里的软件包少一个也不能提测（「无变化」不排除）", async () => {
  await assert.rejects(
    createRelease(
      releaseInput({
        version: "25.1.4",
        packages: [
          { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
          { packageName: pkgName("b"), branch: "develop/eagle", commitSha: SHA_B, customTag: null },
        ],
      }),
      { createdById: fixture.userId, reader },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 400);
      assert.match(error.message, /没有进提测/);
      return true;
    },
  );
});

test("同一项目里版本号重复时给出可读的拒绝信息", async () => {
  await assert.rejects(
    createRelease(releaseInput({ version: "25.0.2" }), { createdById: fixture.userId, reader }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /25\.0\.2/);
      return true;
    },
  );
});

test("已删除的项目不能再创建提测", async () => {
  const project = await prisma.project.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectManagerId: fixture.managerId,
      baselineId: fixture.baselineId,
      key: `${PREFIX}-deleted`,
      name: `${PREFIX} 已删除项目`,
      deletedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  await assert.rejects(
    createRelease(
      releaseInput({ projectId: project.id, version: "25.1.5", packages: [] }),
      { createdById: fixture.userId, reader },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 404);
      assert.match(error.message, /已删除/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 接口层：请求体校验与项目归属
// ---------------------------------------------------------------------------

function request(body: unknown): Request {
  return new Request("http://localhost/api/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("请求体不是 JSON 时返回 400", async () => {
  const response = await POST(request("not json"));

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_json");
});

test("字段校验未通过时返回 400，details 里逐条给出字段", async () => {
  const response = await POST(request({}));

  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; details: Array<{ field: string }> };
  };
  assert.equal(body.error.code, "invalid_payload");
  assert.deepEqual(
    body.error.details.map((item) => item.field),
    ["projectId", "version", "packages"],
  );
});

test("项目不存在时返回 404，不进入权限判定", async () => {
  const response = await POST(
    request({
      projectId: "00000000-0000-7000-8000-000000000000",
      version: "25.2.0",
      packages: [
        { packageName: pkgName("a"), branch: "develop/eagle", commitSha: SHA_A, customTag: null },
      ],
    }),
  );

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "project_not_found");
});
