/**
 * 应用运行所需的环境变量。
 *
 * 这里只列出当前代码真正读取的变量；外部系统（CRP、Gerrit、Shuttle）的凭据
 * 在对应集成节点接入时再追加，避免提前定义无人使用的配置。
 */
export type AppEnv = {
  DATABASE_URL: string;
};

export function readEnv(
  source: Record<string, string | undefined> = process.env,
): AppEnv {
  const databaseUrl = source.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      "缺少必需的环境变量 DATABASE_URL。请复制 .env.example 为 .env 并填写数据库连接串。",
    );
  }

  return { DATABASE_URL: databaseUrl };
}
