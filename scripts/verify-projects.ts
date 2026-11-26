/**
 * 项目经理与项目的真实数据库验收。
 *
 * 跑一遍本单 AC 里需要落库才能证明的部分：项目经理必须属于项目所在工作区、两个项目可以共用
 * 一个基线、未同步的基线被拒绝、复制项目带走清单但不带提交历史、删项目后历史提测记录仍可查、
 * 项目卡片的拓扑顺序与依赖环告警。
 *
 * 用法：pnpm db:migrate && pnpm db:seed && pnpm tsx scripts/verify-projects.ts
 *
 * 只动自己建的临时行，跑完全部删掉：种子里的 4 个项目、5 条提测记录、12 个软件包保持原样。
 * 「删项目」那一项会临时软删种子项目再恢复，跑完 `deleted_at` 依旧是空。
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import {
  addProjectSoftware,
  copyProject,
  createManager,
  createProject,
  getProject,
  joinFieldErrors,
  listBaselineChoices,
  listManagers,
  listProjectCards,
  parseProjectInput,
  ProjectError,
  removeProjectSoftware,
  updateManager,
  softDeleteProject,
  updateProjectSoftwareBranch,
} from "../lib/projects";

let passed = 0;
let failed = 0;

function ok(label: string, detail: string): void {
  passed += 1;
  console.log(`✅ ${label}｜${detail}`);
}

function bad(label: string, detail: string): void {
  failed += 1;
  console.log(`❌ ${label}｜${detail}`);
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    ok(label, detail);
    return;
  }

  bad(label, detail);
}

/** 断言某个操作被拒绝，并且提示里含指定文字。 */
async function expectReject(label: string, action: () => Promise<unknown>, needle: string) {
  try {
    await action();
    bad(label, "本该被拒绝，实际成功了");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProjectError && message.includes(needle)) {
      ok(label, `拒绝原因：${message}`);
      return;
    }

    bad(label, `拒绝原因不符预期（期望含「${needle}」）：${message}`);
  }
}

const createdProjects: string[] = [];
const createdManagers: string[] = [];
const createdPackages: string[] = [];
const createdBaselines: string[] = [];

async function cleanup(): Promise<void> {
  if (createdProjects.length > 0) {
    await prisma.projectSoftware.deleteMany({ where: { projectId: { in: createdProjects } } });
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }

  if (createdManagers.length > 0) {
    await prisma.projectManager.deleteMany({ where: { id: { in: createdManagers } } });
  }

  if (createdPackages.length > 0) {
    await prisma.packageDependency.deleteMany({
      where: {
        OR: [
          { packageId: { in: createdPackages } },
          { upstreamPackageId: { in: createdPackages } },
        ],
      },
    });
    await prisma.package.deleteMany({ where: { id: { in: createdPackages } } });
  }

  if (createdBaselines.length > 0) {
    await prisma.syncRun.deleteMany({ where: { targetId: { in: createdBaselines } } });
    await prisma.baseline.deleteMany({ where: { id: { in: createdBaselines } } });
  }
}

async function workspace(slug: string) {
  const row = await prisma.workspace.findUnique({ where: { slug }, select: { id: true, name: true } });

  if (row === null) {
    throw new Error(`种子里没有工作区 ${slug}，先跑 pnpm db:seed。`);
  }

  return row;
}

async function main(): Promise<void> {
  const core = await workspace("desktop-core");
  const security = await workspace("security");

  const managers = await listManagers(core.id);
  const liwei = managers.find((item) => item.name === "李伟");
  const liuyang = (await listManagers(security.id)).find((item) => item.name === "刘洋");

  if (liwei === undefined || liuyang === undefined) {
    throw new Error("种子里找不到李伟或刘洋，先跑 pnpm db:seed。");
  }

  const baselines = await prisma.baseline.findMany({ select: { id: true, name: true, syncedAt: true } });
  const eagle1071 = baselines.find((item) => item.name === "eagle-1071");
  const snipe2500u2 = baselines.find((item) => item.name === "snipe-2500u2");

  if (eagle1071 === undefined || snipe2500u2 === undefined) {
    throw new Error("种子里找不到 eagle-1071 或 snipe-2500u2，先跑 pnpm db:seed。");
  }

  console.log("== AC1 项目经理必填、必须属于项目所在工作区 ==\n");

  const missingManager = parseProjectInput({
    name: "验证项目",
    key: "verify-no-manager",
    projectManagerId: "",
    baselineId: eagle1071.id,
    description: "",
  });

  check(
    "未选项目经理时保存被拒绝",
    !missingManager.ok &&
      missingManager.errors.some((error) => error.message.includes("请选择项目经理")),
    `页面提示：${missingManager.ok ? "（未拒绝）" : joinFieldErrors(missingManager.errors)}`,
  );

  await expectReject(
    "项目经理不属于这个工作区时被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-跨工作区经理",
        key: "verify-cross-manager",
        projectManagerId: liuyang.id,
        baselineId: eagle1071.id,
        description: null,
      }),
    "不属于这个工作区",
  );

  // 绑定了平台账号、但那个账号不是本工作区成员的项目经理。
  const admin = await prisma.user.findUnique({
    where: { email: "admin@uniontech.com" },
    select: { id: true },
  });

  const orphanManager = await prisma.projectManager.create({
    data: { workspaceId: core.id, name: "验证-未入工作区的账号", userId: admin?.id ?? null },
    select: { id: true, name: true },
  });
  createdManagers.push(orphanManager.id);

  await expectReject(
    "项目经理绑定的账号不是本工作区成员时被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-账号未入工作区",
        key: "verify-orphan-manager",
        projectManagerId: orphanManager.id,
        baselineId: eagle1071.id,
        description: null,
      }),
    "还不是本工作区的成员",
  );

  const first = await createProject(core.id, {
    name: "验证项目-甲",
    key: "verify-a",
    projectManagerId: liwei.id,
    baselineId: eagle1071.id,
    description: "AC2 建的两个项目共用同一个基线",
  });
  createdProjects.push(first.id);
  ok("项目经理属于本工作区时可以保存", `已建项目 ${first.id}`);

  console.log("\n== AC2 两个项目共用一个基线；基线必须已同步 ==\n");

  const second = await createProject(core.id, {
    name: "验证项目-乙",
    key: "verify-b",
    projectManagerId: liwei.id,
    baselineId: eagle1071.id,
    description: null,
  });
  createdProjects.push(second.id);

  const shared = await listProjectCards(core.id);
  const firstCard = shared.find((item) => item.id === first.id);
  const secondCard = shared.find((item) => item.id === second.id);

  check(
    "两个不同的项目同时指向同一个基线",
    firstCard?.baseline.id === eagle1071.id && secondCard?.baseline.id === eagle1071.id,
    `甲=${firstCard?.baseline.name} 乙=${secondCard?.baseline.name}，基线 id 都是 ${eagle1071.id}`,
  );

  const unsynced = await prisma.baseline.create({
    data: { crpBranchId: "verify-unsynced", name: "verify-unsynced", syncedAt: null },
    select: { id: true },
  });
  createdBaselines.push(unsynced.id);

  await expectReject(
    "基线不在已同步列表里时保存被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-未同步基线",
        key: "verify-unsynced-baseline",
        projectManagerId: liwei.id,
        baselineId: unsynced.id,
        description: null,
      }),
    "还没有同步过",
  );

  await expectReject(
    "基线不存在时保存被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-假基线",
        key: "verify-missing-baseline",
        projectManagerId: liwei.id,
        baselineId: "00000000-0000-7000-8000-000000000000",
        description: null,
      }),
    "基线不存在",
  );

  console.log("\n== AC2 后半：A9 的基线状态决定可选性（已消失 / 同步失败 / 未同步）==\n");

  const missingNow = new Date();
  const missing = await prisma.baseline.create({
    data: {
      crpBranchId: "verify-missing",
      name: "verify-missing",
      syncedAt: missingNow,
      missingAt: missingNow,
    },
    select: { id: true },
  });
  const failed = await prisma.baseline.create({
    data: { crpBranchId: "verify-failed", name: "verify-failed", syncedAt: missingNow },
    select: { id: true },
  });
  createdBaselines.push(missing.id, failed.id);
  await prisma.syncRun.create({
    data: {
      kind: "baseline_packages",
      status: "failed",
      trigger: "manual",
      targetId: failed.id,
      errorMessage: "验证注入：上游返回 502",
    },
  });

  const choices = await listBaselineChoices();
  const choiceById = new Map(choices.map((item) => [item.id, item]));

  check(
    "已从 CRP 消失的基线状态是「已消失」",
    choiceById.get(missing.id)?.state === "missing",
    `状态=${choiceById.get(missing.id)?.stateLabel ?? "查不到"}`,
  );
  check(
    "最近一次同步失败的基线状态是「同步失败」，不被上一次成功的时间戳盖住",
    choiceById.get(failed.id)?.state === "failed",
    `状态=${choiceById.get(failed.id)?.stateLabel ?? "查不到"}，最近一次失败原因=${choiceById.get(failed.id)?.latestError ?? "无"}`,
  );
  check(
    "种子里同步过的基线仍是「已同步」，可选列表里留得下",
    choiceById.get(eagle1071.id)?.state === "synced",
    `${choiceById.get(eagle1071.id)?.name} 状态=${choiceById.get(eagle1071.id)?.stateLabel ?? "查不到"}`,
  );

  await expectReject(
    "已消失的基线保存被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-已消失基线",
        key: "verify-missing-baseline",
        projectManagerId: liwei.id,
        baselineId: missing.id,
        description: null,
      }),
    "已从 CRP 分支列表消失",
  );

  await expectReject(
    "同步失败的基线保存被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-失败基线",
        key: "verify-failed-baseline",
        projectManagerId: liwei.id,
        baselineId: failed.id,
        description: null,
      }),
    "同步失败",
  );

  await expectReject(
    "未同步的基线保存被拒绝",
    () =>
      createProject(core.id, {
        name: "验证项目-未同步基线2",
        key: "verify-unsynced-baseline-2",
        projectManagerId: liwei.id,
        baselineId: unsynced.id,
        description: null,
      }),
    "还没有同步过",
  );

  console.log("\n== AC3 复制 6 个软件包的项目：清单与默认分支一致，提交历史为空 ==\n");

  const source = await createProject(core.id, {
    name: "验证项目-六包源",
    key: "verify-six-source",
    projectManagerId: liwei.id,
    baselineId: snipe2500u2.id,
    description: "复制源，故意写上提交历史",
  });
  createdProjects.push(source.id);

  const sixNames = [
    "kwin",
    "dde-file-manager",
    "dde-dock",
    "dde-session-shell",
    "deepin-polkit-agent",
    "dde-launchpad",
  ];
  const packagesByHand = new Map(
    (
      await prisma.package.findMany({
        where: { name: { in: sixNames } },
        select: { id: true, name: true, defaultBranch: true },
      })
    ).map((item) => [item.name, item]),
  );

  for (const name of sixNames) {
    const pkg = packagesByHand.get(name);
    if (pkg === undefined) {
      throw new Error(`种子里没有软件包 ${name}。`);
    }

    // dde-launchpad 故意换一个跟踪分支，验证复制带走的是项目里的分支，不是软件包默认分支。
    const trackedBranch = name === "dde-launchpad" ? "develop/override-branch" : pkg.defaultBranch;
    await addProjectSoftware({ projectId: source.id, packageId: pkg.id, trackedBranch });
  }

  await prisma.projectSoftware.updateMany({
    where: { projectId: source.id },
    data: { lastSubmittedCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", lastSubmittedAt: new Date() },
  });

  const sourceRows = await prisma.projectSoftware.findMany({
    where: { projectId: source.id },
    select: { packageId: true, trackedBranch: true, lastSubmittedCommit: true },
    orderBy: { packageId: "asc" },
  });

  const copy = await copyProject(source.id, {
    name: "验证项目-六包副本",
    key: "verify-six-copy",
    projectManagerId: liwei.id,
    baselineId: eagle1071.id,
    description: null,
  });
  createdProjects.push(copy.id);

  const copyRows = await prisma.projectSoftware.findMany({
    where: { projectId: copy.id },
    select: { packageId: true, trackedBranch: true, lastSubmittedCommit: true, lastSubmittedAt: true },
    orderBy: { packageId: "asc" },
  });

  const sameList =
    sourceRows.length === 6 &&
    copyRows.length === 6 &&
    sourceRows.every(
      (row, index) =>
        row.packageId === copyRows[index]?.packageId &&
        row.trackedBranch === copyRows[index]?.trackedBranch,
    );

  check(
    "副本清单与源项目逐项一致（6 个包，含被覆盖的跟踪分支）",
    sameList,
    `源 ${sourceRows.length} 项 / 副本 ${copyRows.length} 项；dde-launchpad 分支=${copyRows.find((row) => row.packageId === packagesByHand.get("dde-launchpad")?.id)?.trackedBranch}`,
  );

  check(
    "副本的 lastSubmittedCommit 与 lastSubmittedAt 全为空",
    copyRows.every((row) => row.lastSubmittedCommit === null && row.lastSubmittedAt === null),
    `源项目的提交号有 ${sourceRows.filter((row) => row.lastSubmittedCommit !== null).length} 项，副本为 ${copyRows.filter((row) => row.lastSubmittedCommit !== null).length} 项`,
  );

  const copyCard = await getProject(copy.id);
  check(
    "副本可以照常查看，基线换成了自己选的",
    copyCard !== null && copyCard.baseline.id === eagle1071.id && copyCard.software.count === 6,
    `基线=${copyCard?.baseline.name}，软件数=${copyCard?.software.count}，依赖数=${copyCard?.software.dependencyCount}，顺序=${copyCard?.software.order.join(" → ")}`,
  );

  console.log("\n== 清单管理：加包、改分支、移包、拓扑顺序 ==\n");

  const managed = await createProject(core.id, {
    name: "验证项目-清单增删",
    key: "verify-software",
    projectManagerId: liwei.id,
    baselineId: eagle1071.id,
    description: null,
  });
  createdProjects.push(managed.id);

  const polkit = packagesByHand.get("deepin-polkit-agent");
  const sessionShell = packagesByHand.get("dde-session-shell");
  const kwin = packagesByHand.get("kwin");
  const dock = packagesByHand.get("dde-dock");

  if (!polkit || !sessionShell || !kwin || !dock) {
    throw new Error("种子里缺少依赖链上的软件包。");
  }

  await addProjectSoftware({ projectId: managed.id, packageId: dock.id, trackedBranch: "develop/eagle" });
  await addProjectSoftware({ projectId: managed.id, packageId: sessionShell.id, trackedBranch: "develop/eagle" });
  await addProjectSoftware({ projectId: managed.id, packageId: kwin.id, trackedBranch: "develop/eagle" });
  await addProjectSoftware({ projectId: managed.id, packageId: polkit.id, trackedBranch: "develop/eagle" });

  const ordered = await listProjectCards(core.id).then((cards) => cards.find((card) => card.id === managed.id));

  check(
    "项目卡片按依赖排出了投递顺序",
    ordered?.software.order[0] === "deepin-polkit-agent" &&
      ordered.software.order.indexOf("dde-session-shell") < ordered.software.order.indexOf("dde-dock"),
    `顺序=${ordered?.software.order.join(" → ")}，依赖数=${ordered?.software.dependencyCount}，环=${ordered?.software.cycle === null ? "无" : "有"}`,
  );

  await updateProjectSoftwareBranch({
    projectId: managed.id,
    packageId: kwin.id,
    trackedBranch: "develop/snipe",
  });
  const branchRow = await prisma.projectSoftware.findUnique({
    where: { projectId_packageId: { projectId: managed.id, packageId: kwin.id } },
    select: { trackedBranch: true },
  });
  check("改跟踪分支只动 branch 一列", branchRow?.trackedBranch === "develop/snipe", `kwin 现在是 ${branchRow?.trackedBranch}`);

  await removeProjectSoftware({ projectId: managed.id, packageId: kwin.id });
  const afterRemove = await listProjectCards(core.id).then((cards) => cards.find((card) => card.id === managed.id));
  check(
    "移除后清单里不再有那个包",
    afterRemove?.software.count === 3 && !afterRemove.software.order.includes("kwin"),
    `清单：${afterRemove?.software.order.join(" → ")}`,
  );

  // 依赖环告警：临时建两个互相依赖的软件包，加进清单后卡片必须报环。
  const cycleA = await prisma.package.create({
    data: { name: "verify-cycle-a", repoPath: "verify/cycle-a", defaultBranch: "develop/eagle" },
    select: { id: true },
  });
  const cycleB = await prisma.package.create({
    data: { name: "verify-cycle-b", repoPath: "verify/cycle-b", defaultBranch: "develop/eagle" },
    select: { id: true },
  });
  createdPackages.push(cycleA.id, cycleB.id);
  await prisma.packageDependency.createMany({
    data: [
      { packageId: cycleA.id, upstreamPackageId: cycleB.id },
      { packageId: cycleB.id, upstreamPackageId: cycleA.id },
    ],
  });
  await addProjectSoftware({ projectId: managed.id, packageId: cycleA.id, trackedBranch: "develop/eagle" });
  await addProjectSoftware({ projectId: managed.id, packageId: cycleB.id, trackedBranch: "develop/eagle" });

  const cycled = await listProjectCards(core.id).then((cards) => cards.find((card) => card.id === managed.id));
  check(
    "清单里出现依赖环时卡片报环，且清单条目不丢",
    cycled?.software.cycle !== null &&
      cycled?.software.cycle !== undefined &&
      cycled.software.count === 5,
    `环=${cycled?.software.cycle?.join(" → ") ?? "未报"}，清单仍有 ${cycled?.software.count} 个包`,
  );

  console.log("\n== AC4 删掉被提测记录引用的项目，历史提测记录仍可查 ==\n");

  const withReleases = await prisma.project.findFirst({
    where: { workspaceId: core.id, deletedAt: null, releases: { some: {} } },
    select: { id: true, name: true, _count: { select: { releases: true } } },
  });

  if (withReleases === null) {
    throw new Error("种子里没有带提测记录的项目，先跑 pnpm db:seed。");
  }

  const releaseIds = (
    await prisma.release.findMany({ where: { projectId: withReleases.id }, select: { id: true } })
  ).map((row) => row.id);

  await softDeleteProject(withReleases.id);

  const listedAfterDelete = await listProjectCards(core.id);
  const stillReadable = await prisma.release.findMany({
    where: { id: { in: releaseIds } },
    select: { id: true, version: true, project: { select: { name: true, deletedAt: true } } },
  });
  const hiddenByDefault = await getProject(withReleases.id);
  const visibleToAudit = await getProject(withReleases.id, { includeDeleted: true });

  check(
    "软删后项目不在列表里",
    !listedAfterDelete.some((card) => card.id === withReleases.id),
    `「${withReleases.name}」已从列表消失，列表剩 ${listedAfterDelete.length} 个项目`,
  );

  check(
    "历史提测记录仍然查得到，且指向原项目",
    stillReadable.length === releaseIds.length &&
      stillReadable.every((row) => row.project.name === withReleases.name),
    `${stillReadable.length} 条提测记录：${stillReadable.map((row) => `${row.project.name} / ${row.version}`).join("、")}`,
  );

  check(
    "默认查询把已删项目挡掉，带 includeDeleted 时能翻出来",
    hiddenByDefault === null && visibleToAudit?.deletedAt !== null,
    `默认查询=${hiddenByDefault === null ? "null" : "有结果"}，includeDeleted 的 deletedAt=${visibleToAudit?.deletedAt?.toISOString() ?? "null"}`,
  );

  // 恢复种子项目的软删标记，后面的节点（A11 起要在这个项目上建提测）照常用。
  await prisma.project.update({ where: { id: withReleases.id }, data: { deletedAt: null } });
  ok("已恢复种子项目的软删标记", `「${withReleases.name}」重新出现在列表里`);

  console.log("\n== 项目经理的新建、列表与改名 ==\n");

  const manager = await createManager(core.id, {
    name: "验证-项目经理",
    email: "verify-manager@uniontech.com",
  });
  createdManagers.push(manager.id);

  await expectReject(
    "同一工作区内项目经理重名被拒绝",
    () => createManager(core.id, {
      name: "验证-项目经理",
      email: "verify-manager@uniontech.com",
    }),
    "已经有叫「验证-项目经理」的项目经理",
  );

  await updateManager(manager.id, {
    name: "验证-项目经理改名",
    email: "verify-manager-renamed@uniontech.com",
  });
  const renamed = (await listManagers(core.id)).find((item) => item.id === manager.id);
  check("改名生效，列表里显示新名字与名下项目数", renamed?.name === "验证-项目经理改名", `${renamed?.name}，名下 ${renamed?.projectCount} 个项目`);
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n== 结果：通过 ${passed} 项，失败 ${failed} 项 ==`);

    if (failed > 0) {
      process.exitCode = 1;
      return;
    }

    console.log("临时数据已清理，种子数据保持原样。");
  })
  .catch(async (error) => {
    await cleanup().catch(() => undefined);
    console.error("验收脚本执行失败：", error);
    process.exitCode = 1;
  });
