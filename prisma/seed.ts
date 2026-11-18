import "dotenv/config";

import { prisma } from "../lib/db";

const HEALTH_CHECKS = ["迁移与种子链路验证", "示例数据行"];

async function seed() {
  for (const label of HEALTH_CHECKS) {
    await prisma.healthCheck.upsert({
      where: { label },
      update: {},
      create: { label },
    });
  }

  const total = await prisma.healthCheck.count();
  console.log(`种子数据写入完成，health_check 表共 ${total} 行。`);
}

async function main() {
  try {
    await seed();
  } finally {
    await prisma.$disconnect();
  }
}

// 种子与断开连接的任何失败都落到同一个 catch，避免出现无人处理的 Promise 拒绝。
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
