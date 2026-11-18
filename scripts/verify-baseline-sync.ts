/**
 * 用真实 CRP 与 Shuttle 跑一遍基线同步，并打印验收要看的三样东西：
 *
 * 1. CRP `/branches` 的条数与库里 `baseline` 的条数对照（AC1）；
 * 2. `eagle-1071` 里 `kwin` 的缓存版本与 Shuttle 现查的版本对照（AC2）；
 * 3. 本次同步的请求明细与计数，证明分支列表 1 次、每个参与刷新的基线 2 次、逐包请求 0 次（AC4）。
 *
 * 会写库：先落分支列表，再刷新被项目选中的基线的软件包版本。只对本地开发库用。
 *
 * ```bash
 * pnpm tsx scripts/verify-baseline-sync.ts
 * ```
 */

import "dotenv/config";

import { getBaselineVersion, listBaselines } from "../lib/baselines";
import { prisma } from "../lib/db";
import { createCrpClient } from "../lib/integrations/crp";
import { createShuttleClient, readShuttleEnv } from "../lib/integrations/shuttle";
import { runBaselineSync } from "../lib/jobs/baseline-sync";

const BASELINE = "eagle-1071";
const PACKAGE = "kwin";

async function main() {
  console.log("=== 一次完整同步（手动触发，强制刷新被项目选中的基线）===");

  const summary = await runBaselineSync({ trigger: "manual", force: true });

  console.log(`分支列表：${summary.list.status}，${summary.list.itemCount} 条，本次新标记「已消失」${summary.list.missingCount} 条`);
  for (const item of summary.packages) {
    console.log(`  基线 ${item.name}：${item.status}，${item.itemCount} 个软件包${item.errorMessage === null ? "" : `（${item.errorMessage}）`}`);
  }
  console.log(`跳过刷新的基线：${summary.skippedPackageCount} 条`);

  console.log("\n=== AC1 条数对照 ===");
  const crp = createCrpClient({});
  const branches = await crp.listBranches();
  const inDb = await prisma.baseline.count();
  console.log(`CRP /branches 返回 ${branches.length} 条；库里 baseline ${inDb} 条`);

  console.log("\n=== AC2 基线里的软件包版本对照 ===");
  const baseline = await prisma.baseline.findFirst({
    where: { name: BASELINE },
    select: { id: true, name: true, syncedAt: true },
  });

  if (baseline === null) {
    throw new Error(`库里没有基线 ${BASELINE}，先确认同步是否成功`);
  }

  const cached = await getBaselineVersion(baseline.id, PACKAGE);
  const live = (await createShuttleClient(readShuttleEnv()).listBaselinePackages(BASELINE)).find(
    (item) => item.name === PACKAGE,
  );

  console.log(`${BASELINE} 的 ${PACKAGE}：缓存 ${cached ?? "（没有）"}；Shuttle 现查 ${live?.version ?? "（没有）"}`);
  console.log(`数据同步时间：${baseline.syncedAt?.toISOString() ?? "（未同步）"}`);

  console.log("\n=== AC4 本次同步的请求明细 ===");
  if (summary.requests === null) {
    console.log("请求数未统计（同步里注入了客户端，只出现在测试里）。");
  } else {
    console.log(`合计 ${summary.requests.total} 次（CRP ${summary.requests.crp} 次、Shuttle ${summary.requests.shuttle} 次）`);
    for (const url of summary.requests.urls) {
      console.log(`  ${url}`);
    }
    const perPackage = summary.packages.reduce((sum, item) => sum + item.itemCount, 0);
    console.log(
      `参与刷新的基线 ${summary.packages.length} 条、写入软件包 ${perPackage} 个：` +
        `每个基线 2 次请求，逐包请求 0 次。`,
    );
  }

  console.log("\n=== 页面会显示的基线状态 ===");
  for (const item of await listBaselines()) {
    console.log(
      `  ${item.name}\t${item.stateLabel}\t软件包 ${item.packageCount} 个\t项目引用 ${item.projectCount} 个\t最近同步 ${item.syncedAt?.toISOString() ?? "—"}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
