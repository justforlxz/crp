import "dotenv/config";

import { prisma } from "../lib/db";

const HEALTH_CHECKS = ["迁移与种子链路验证", "示例数据行"];

async function main() {
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

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
