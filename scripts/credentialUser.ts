/**
 * 凭据脚本的「用谁的凭据」。
 *
 * 改造前脚本读两个全局环境变量里的 CRP / Gerrit 账号密码（现已删除）；改造后凭据按人存在库里，
 * 环境变量里什么账号都没有了（`.agents/spec/product/credentials.md` 第十节）。所以脚本必须
 * 自己指名一个平台账号：
 *
 * ```bash
 * pnpm tsx scripts/verify-crp.ts --user you@example.com
 * # 或者
 * CREDENTIAL_USER_EMAIL=you@example.com pnpm tsx scripts/verify-crp.ts
 * ```
 *
 * 脚本会去库里找这个账号配置的凭据来登录，不再接受任何写在命令行或环境变量里的密码 ——
 * 那些东西会进 shell 历史与进程列表。
 */

import { prisma } from "../lib/db";

/** 环境变量里放账号邮箱的那个名字。 */
export const CREDENTIAL_USER_EMAIL_ENV = "CREDENTIAL_USER_EMAIL";

/**
 * 从命令行与环境变量里取平台账号邮箱。
 *
 * 支持 `--user a@b` 与 `--user=a@b` 两种写法，优先级高于环境变量。都没有就返回 `null`。
 */
export function readScriptUserEmail(
  argv: readonly string[] = process.argv.slice(2),
  source: Record<string, string | undefined> = process.env,
): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;

    if (item === "--user") {
      const value = argv[index + 1]?.trim();
      return value ? value : null;
    }

    if (item.startsWith("--user=")) {
      const value = item.slice("--user=".length).trim();
      return value ? value : null;
    }
  }

  const fromEnv = source[CREDENTIAL_USER_EMAIL_ENV]?.trim();

  return fromEnv ? fromEnv : null;
}

/** 按邮箱查平台账号 ID；查不到就报错，并把这条命令该怎么写清楚地说出来。 */
export async function findScriptUserId(email: string): Promise<string> {
  const account = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (account === null) {
    throw new Error(`库里没有账号 ${email}，先在平台上注册这个账号。`);
  }

  return account.id;
}

/**
 * 脚本必须的调用身份。
 *
 * 没给账号时直接报错：凭据按人存放之后，脚本没法再「拿某个全局账号」跑，
 * 静默挑一个账号会让审计记录指向错误的人。
 */
export async function requireScriptUserId(
  argv: readonly string[] = process.argv.slice(2),
  source: Record<string, string | undefined> = process.env,
): Promise<string> {
  const email = readScriptUserEmail(argv, source);

  if (email === null) {
    throw new Error(
      "缺少要用的平台账号：用 `--user <邮箱>` 或环境变量 " +
        `${CREDENTIAL_USER_EMAIL_ENV} 指定。这个账号要已经在「我的账号」里配置过凭据。`,
    );
  }

  return findScriptUserId(email);
}
