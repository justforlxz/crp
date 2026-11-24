/**
 * 功能组：软件包与基线同步（FUNC-14 ~ FUNC-16）。
 *
 * 基线同步的断言放在 `syncBaselineList` 上：它接受的 `crp` 是一个只有 `listBranches` 的对象，
 * 于是「落库的 `crpBranchId` 到底取自响应的 `id` 还是从分支名里截出来的数字」这件事
 * 可以脱开真实 CRP 验证 —— 给一个 `id: 907108` / `name: eagle-1071` 的分支，
 * 两种实现给出的结果完全不同。
 */

import "dotenv/config";

import { after, before } from "node:test";

import type { CrpBranch, CrpRawBranch } from "../../../lib/integrations/crp";
import { acceptanceWithEnv } from "../support/case";
import { db, disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac14";

/** 本次同步写进库的那条基线：ID 与名字刻意不一致，名字里的数字是 1071。 */
const SYNCED_ID = "907108";
const SYNCED_NAME = "eagle-1071";

const FIRST_SYNC_AT = new Date("2026-11-21T10:00:00Z");
const SECOND_SYNC_AT = new Date("2026-11-22T10:00:00Z");

let fixture: Fixture | null = null;

/**
 * 同步前种子里那些基线的 `missingAt`。
 *
 * `syncBaselineList` 会把本次没有返回的分支全部标成「已消失」。本夹具只回一条分支，
 * 于是种子里的几条基线会被标成消失 —— 那是同步的真实行为，不是本文件的意图。
 * 收尾时按快照复原，保证「不碰种子数据」这句话与实现一致。
 */
let seededBaselines: Array<{ id: string; missingAt: Date | null }> = [];

function branchOf(): CrpBranch {
  return {
    id: Number(SYNCED_ID),
    name: SYNCED_NAME,
    description: "验收用分支",
    repoType: "deb",
    isCheck: false,
    raw: {} as CrpRawBranch,
  };
}

/** 只实现 `listBranches` 的假的 CRP：同步只需要这一个能力。 */
function fakeCrp(): { listBranches: () => Promise<CrpBranch[]> } {
  return { listBranches: () => Promise.resolve([branchOf()]) };
}

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);

  const prisma = await db();
  seededBaselines = await prisma.baseline.findMany({
    where: { crpBranchId: { not: { startsWith: PREFIX } } },
    select: { id: true, missingAt: true },
  });
});

after(async () => {
  if (fixture !== null) {
    const prisma = await db();
    await prisma.baseline.deleteMany({ where: { crpBranchId: SYNCED_ID } });
    await prisma.syncRun.deleteMany({
      where: { startedAt: { in: [FIRST_SYNC_AT, SECOND_SYNC_AT] } },
    });
  }

  if (fixture !== null) {
    const prisma = await db();

    for (const baseline of seededBaselines) {
      await prisma.baseline.update({
        where: { id: baseline.id },
        data: { missingAt: baseline.missingAt },
      });
    }
  }

  await fixture?.cleanup();
  await disconnect();
});

acceptanceWithEnv("FUNC-14", FIXTURE_ENV, async () => {
  const [{ listPackages }, { resolveCrpProjectName }] = await Promise.all([
    import("../../../lib/packages"),
    import("../../../lib/packages"),
  ]);

  const packageName = `${PREFIX}-dde-file-manager`;
  const crpProjectName = `${PREFIX}_filemanager`;

  await fixture!.package({ name: packageName, crpProjectName });
  await fixture!.package({ name: `${PREFIX}-kwin` });

  const packages = await listPackages();
  const withCrp = packages.find((item) => item.name === packageName);
  const withoutCrp = packages.find((item) => item.name === `${PREFIX}-kwin`);

  expectEqual("FUNC-14", "包名列", packageName, withCrp?.name);
  expectEqual("FUNC-14", "CRP 项目名列", crpProjectName, withCrp?.crpProjectName);
  expectEqual(
    "FUNC-14",
    "查找 CRP 主题用的名字（登记了 CRP 项目名）",
    crpProjectName,
    resolveCrpProjectName({ name: packageName, crpProjectName }),
  );
  expectEqual(
    "FUNC-14",
    "查找 CRP 主题用的名字（没登记时退回包名）",
    `${PREFIX}-kwin`,
    resolveCrpProjectName({ name: withoutCrp?.name ?? `${PREFIX}-kwin`, crpProjectName: null }),
  );
});

acceptanceWithEnv("FUNC-15", FIXTURE_ENV, async () => {
  const { syncBaselineList } = await import("../../../lib/jobs/baseline-sync");
  const prisma = await db();

  await syncBaselineList(fakeCrp(), { trigger: "manual", now: FIRST_SYNC_AT });

  const baseline = await prisma.baseline.findUnique({
    where: { crpBranchId: SYNCED_ID },
    select: { crpBranchId: true, name: true },
  });

  expectEqual("FUNC-15", "落库的 crpBranchId", SYNCED_ID, baseline?.crpBranchId);
  expectEqual("FUNC-15", "落库的分支名", SYNCED_NAME, baseline?.name);
  expectTrue(
    "FUNC-15",
    "crpBranchId 不是从名字里截出来的数字",
    `crpBranchId 不等于 "1071"（当前 ${String(baseline?.crpBranchId)}）`,
    baseline?.crpBranchId !== "1071",
  );
});

acceptanceWithEnv("FUNC-16", FIXTURE_ENV, async () => {
  const { syncBaselineList, syncBaselinePackages } = await import("../../../lib/jobs/baseline-sync");
  const prisma = await db();

  // Shuttle 只回一条包版本与一组架构：`syncedAt` 由这一层写，分支列表同步不碰它。
  const shuttle = {
    getBaselineRepository: () =>
      Promise.resolve({
        packages: [{ name: `${PREFIX}-kwin`, version: "5.27.10-1" }],
        info: {
          reponame: SYNCED_NAME,
          repotype: "deb",
          addresses: [],
          arches: ["amd64", "arm64"],
        },
      }),
  };

  /** 跑一轮「分支列表 + 软件包版本」，返回这一轮的基线候选。 */
  async function syncOnce(now: Date): Promise<void> {
    await syncBaselineList(fakeCrp(), { trigger: "manual", now });

    const rows = await prisma.baseline.findMany({
      where: { crpBranchId: SYNCED_ID },
      select: { id: true, name: true, syncedAt: true, missingAt: true },
    });

    await syncBaselinePackages(shuttle, rows, { trigger: "manual", now });
  }

  await syncOnce(FIRST_SYNC_AT);
  await syncOnce(SECOND_SYNC_AT);

  const baselines = await prisma.baseline.findMany({
    where: { crpBranchId: SYNCED_ID },
    select: { id: true, syncedAt: true },
  });

  expectEqual("FUNC-16", "连续同步两次后的基线记录数", 1, baselines.length);

  const versions = await prisma.baselinePackageVersion.count({
    where: { baselineId: baselines[0]?.id ?? "" },
  });

  expectEqual("FUNC-16", "连续同步两次后的软件包版本行数", 1, versions);
  expectEqual(
    "FUNC-16",
    "最近同步时间被第二次同步刷新",
    SECOND_SYNC_AT.toISOString(),
    baselines[0]?.syncedAt?.toISOString(),
  );
});
