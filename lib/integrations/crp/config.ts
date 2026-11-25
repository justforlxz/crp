/**
 * CRP 客户端配置：与凭据无关的设置（地址、超时、重试），以及按人取凭据。
 *
 * 两件事分开是因为它们的来源与生命周期完全不同：
 *
 * - **设置**来自环境变量。地址与超时属于部署，所有人共用一份。
 * - **凭据**来自数据库，按 `userId` 一份（`.agents/spec/product/credentials.md` 第四节）。
 *   环境变量里不再有任何个人账号与密码：原来那四个个人凭据变量已删除，只在文档里留下迁移说明
 *   （验收用例 SEC-07 会全仓扫这几个名字，所以这里也不再写出它们的字面量）。
 *
 * 缺凭据直接抛 `CredentialMissingError`，而不是退回匿名请求：CRP 的写接口匿名只会返回 401，
 * 把「没配置」伪装成「没权限」会让排查跑偏，也会让人以为该去找 CRP 管理员开权限。
 */

import { requireCredentialSecret } from "../../credentials/service";
import { CRP_DEFAULT_BASE_URL, readBaseUrl } from "../endpoints";

export { CRP_DEFAULT_BASE_URL };

export const CRP_DEFAULT_TIMEOUT_MS = 30_000;

/** 失败重试次数（不含首次请求）。 */
export const CRP_DEFAULT_RETRIES = 3;

/** CRP 的设置性环境变量。这里没有任何凭据。 */
export const CRP_ENV = {
  baseUrl: "CRP_BASE_URL",
} as const;

/** 与凭据无关的设置。 */
export type CrpSettings = {
  /** 接口前缀，不带结尾斜杠。 */
  baseUrl: string;
  /** 单次请求超时，毫秒。 */
  timeoutMs: number;
  /** 失败重试次数。 */
  retries: number;
};

/** 一次调用 CRP 需要的全部输入：设置 + 这个人的凭据 + 令牌缓存键。 */
export type CrpConfig = CrpSettings & {
  /** LDAP 账号。 */
  username: string;
  /** LDAP 密码，只在内存里用于这一次登录。 */
  password: string;
  /** 进程内令牌缓存的键，就是账号 ID：不同人的令牌互不覆盖。 */
  tokenKey: string;
};

/** 读与凭据无关的设置。 */
export function readCrpSettings(
  source: Record<string, string | undefined> = process.env,
): CrpSettings {
  return {
    baseUrl: readBaseUrl("crp", source) || CRP_DEFAULT_BASE_URL,
    timeoutMs: CRP_DEFAULT_TIMEOUT_MS,
    retries: CRP_DEFAULT_RETRIES,
  };
}

/**
 * 按人读出完整的 CRP 配置。
 *
 * 这个人没配 CRP 凭据时抛 `CredentialMissingError`，消息里带「去哪个页面配置」。
 * 调用方要在建客户端之前把它显示出来，这样一次 CRP 请求都不会发出去（CRED-6）。
 */
export async function readCrpConfig(
  userId: string,
  source: Record<string, string | undefined> = process.env,
): Promise<CrpConfig> {
  const credential = await requireCredentialSecret(userId, "crp", source);

  return {
    ...readCrpSettings(source),
    username: credential.username,
    password: credential.secret,
    tokenKey: userId,
  };
}
