/**
 * 验收用例的环境判定（MKACG-985）。
 *
 * 三个命令的环境要求不一样，缺环境时必须**跳过并说清楚缺什么**，不能报成通过：
 *
 * | 组 | 需要 | 缺了怎么办 |
 * | --- | --- | --- |
 * | 功能 / 边界 | `DATABASE_URL` | 逐条 skip，原因写进测试名 |
 * | 权限 / 界面 | `BASE_URL`（界面组另需 `DATABASE_URL` 签发会话） | 整组不执行，入口脚本以退出码 2 结束 |
 *
 * `BASE_URL` 也认 `ACCEPTANCE_BASE_URL` 与 `E2E_BASE_URL`：仓库里已有的脚本用后者，
 * 验收的人多半只想设一个，所以三者都收，按优先级取第一个非空值。
 */

/** 用例需要的东西。 */
export type EnvNeed = "database" | "baseUrl";

/** 跳过原因：写给人看，说明缺什么、怎么补。 */
const REASONS: Record<EnvNeed, string> = {
  database:
    "缺少 DATABASE_URL：这组用例要连库。复制 .env.example 为 .env 填好，再执行 pnpm db:migrate 与 pnpm db:seed",
  baseUrl:
    "缺少 BASE_URL：这组用例要一个跑起来的实例。先 pnpm build && pnpm exec next start（种子库上用它会绕开种子自检），再设 BASE_URL=http://127.0.0.1:3000",
};

/** 数据库连接串；没配返回 `null`。 */
export function databaseUrl(): string | null {
  const value = (process.env.DATABASE_URL ?? "").trim();
  return value === "" ? null : value;
}

/** 被验收的实例地址（去掉结尾斜杠）；没配返回 `null`。 */
export function baseUrl(): string | null {
  for (const name of ["ACCEPTANCE_BASE_URL", "BASE_URL", "E2E_BASE_URL"] as const) {
    const value = (process.env[name] ?? "").trim();

    if (value !== "") {
      return value.replace(/\/+$/u, "");
    }
  }

  return null;
}

/** 这一项环境是否齐备。 */
export function hasEnv(need: EnvNeed): boolean {
  return need === "database" ? databaseUrl() !== null : baseUrl() !== null;
}

/** 缺哪一项就返回它的跳过原因；齐备返回 `null`。 */
export function missingEnvReason(needs: readonly EnvNeed[]): string | null {
  const missing = needs.filter((need) => !hasEnv(need));

  if (missing.length === 0) {
    return null;
  }

  return missing.map((need) => REASONS[need]).join("；");
}
