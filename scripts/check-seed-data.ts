/**
 * 部署实例的种子数据自检（`.agents/spec/product/runtime.md` 第一节，RT-3 / RT-4）。
 *
 * 由 `pnpm start` 在 `next start` 之前调用：库里只要有种子特征就写错误日志并以非零退出，
 * 不允许带着演示数据对外服务。判定规则与「为什么只看占位凭据」见 `lib/seed-guard.ts`。
 *
 * 用法：
 *
 *   pnpm start                    # 部署入口：先自检，通过才起服务
 *   pnpm exec tsx scripts/check-seed-data.ts    # 只跑自检，看退出码
 *
 * 退出码：0 通过（库里没有种子数据）；1 检测到种子数据，或读不到库（读不到也拒绝启动，
 * 否则把库连坏就能绕过自检）。
 *
 * 本地开发与测试环境不需要跑它 —— 那些环境本来就该有种子数据，用 `pnpm dev` 或
 * `pnpm exec next start` 起服务即可。
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import {
  detectSeedData,
  formatSeedReport,
  hasDecisiveFinding,
  type SeedGuardSnapshot,
} from "../lib/seed-guard";

/** 四张表各查一次；只取判定需要的列。 */
async function readSnapshot(): Promise<SeedGuardSnapshot> {
  const [users, workspaces, baselines, webhookEndpoints] = await Promise.all([
    prisma.user.findMany({ select: { email: true, passwordHash: true } }),
    prisma.workspace.findMany({ select: { slug: true, name: true } }),
    prisma.baseline.findMany({ select: { name: true, description: true } }),
    prisma.webhookEndpoint.findMany({ select: { url: true, secret: true } }),
  ]);

  return { users, workspaces, baselines, webhookEndpoints };
}

async function main(): Promise<void> {
  let snapshot: SeedGuardSnapshot;

  try {
    snapshot = await readSnapshot();
  } catch (error) {
    // 读不到库时拒绝启动：自检要是能被「库连不上」绕过，它就等于不存在。
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[seed-guard] 读不到数据库，拒绝启动：${message}`);
    console.error("先确认已执行 `pnpm db:migrate`，且数据库连接串可用。");
    process.exitCode = 1;
    return;
  }

  const findings = detectSeedData(snapshot);

  if (findings.length === 0) {
    console.log("[seed-guard] 没有检测到种子数据。");
    return;
  }

  if (hasDecisiveFinding(findings)) {
    console.error(formatSeedReport(findings));
    process.exitCode = 1;
    return;
  }

  // 只有证据、没有决定性特征：只清了一半的部署也要能起来，但要让人看见。
  console.warn(formatSeedReport(findings));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[seed-guard] 自检本身失败，拒绝启动：${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
