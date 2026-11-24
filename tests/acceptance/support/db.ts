/**
 * 数据库的延迟入口（MKACG-985）。
 *
 * 为什么不在文件顶部 `import { prisma } from "../../lib/db"`：那个模块在求值时就调
 * `readEnv()`，缺 `DATABASE_URL` 会直接抛。验收命令必须在没配库的机器上「跳过」而不是
 * 「崩掉」—— 崩掉时连哪条用例被跳过都看不到，和「全部通过」一样没法读。
 *
 * 所以这里只在真正用到库的时候才动态 import 一次。
 */

type PrismaClientLike = Awaited<ReturnType<typeof load>>;

async function load() {
  const loaded = await import("../../../lib/db");
  return loaded.prisma;
}

/** 全进程共用一个实例：`lib/db` 自己已经做过单例处理，这里只是延迟到调用时再取。 */
let cached: PrismaClientLike | null = null;

export async function db(): Promise<PrismaClientLike> {
  if (cached === null) {
    cached = await load();
  }

  return cached;
}

/** 跑完收尾：断开连接池，`node --test` 才能自己退出。 */
export async function disconnect(): Promise<void> {
  if (cached !== null) {
    await cached.$disconnect();
  }
}
