/**
 * CRP 客户端配置：地址、凭据、token 缓存位置、超时与重试次数。
 *
 * 凭据只从环境变量读。仓库里不出现任何真实账号与密码；`.env` 已被 .gitignore 忽略。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { CrpInvalidParameterError } from "./errors";

/** CRP 接口前缀。 */
export const CRP_DEFAULT_BASE_URL = "https://crp.uniontech.com/api";

/**
 * token 缓存位置。
 *
 * 与 CRP 官方 Python 客户端用的 `~/.cache/crp/token` 分开，避免两边互相覆盖。
 */
export const CRP_DEFAULT_TOKEN_PATH = join(homedir(), ".cache", "crp", "jwt");

/**
 * 把路径开头的 `~` 展开成家目录。
 *
 * `.env` 里写 `~/.cache/crp/jwt` 是人之常情，但 Node 不认这个写法：不展开的话
 * 会建出名为 `~` 的字面目录，把 token 写到当前工作目录下（如果当前目录是仓库，
 * token 就落进工作区了）。
 */
export function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

/** 投递请求不带 Arches 时用的架构集合，与 CRP 前端默认值一致。 */
export const CRP_DEFAULT_ARCHES = "amd64;mips64el;arm64;sw64;loong64";

export const CRP_DEFAULT_TIMEOUT_MS = 30_000;

/** 失败重试次数（不含首次请求）。 */
export const CRP_DEFAULT_RETRIES = 3;

/** CRP 环境变量名。 */
export const CRP_ENV = {
  username: "CRP_USERNAME",
  password: "CRP_PASSWORD",
  baseUrl: "CRP_BASE_URL",
  tokenPath: "CRP_TOKEN_PATH",
} as const;

export type CrpConfig = {
  /** 接口前缀，不带结尾斜杠。 */
  baseUrl: string;
  /** LDAP 账号。 */
  username: string;
  /** LDAP 密码，只在内存里用于这一次登录。 */
  password: string;
  /** token 缓存文件路径。 */
  tokenPath: string;
  /** 单次请求超时，毫秒。 */
  timeoutMs: number;
  /** 失败重试次数。 */
  retries: number;
};

/**
 * 从环境变量读出配置。
 *
 * 缺凭据直接抛错，而不是退回匿名请求：CRP 的写接口匿名只会返回 401，
 * 把「没配置」伪装成「没权限」会让排查跑偏。
 */
export function readCrpConfig(
  source: Record<string, string | undefined> = process.env,
): CrpConfig {
  const username = source[CRP_ENV.username]?.trim();
  const password = source[CRP_ENV.password];

  if (!username || !password) {
    throw new CrpInvalidParameterError(
      `缺少 CRP 凭据：需要环境变量 ${CRP_ENV.username} 与 ${CRP_ENV.password}。` +
        "按 .env.example 的说明写进 .env，不要提交。",
    );
  }

  const baseUrl = (source[CRP_ENV.baseUrl]?.trim() || CRP_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const tokenPath = expandHomePath(
    source[CRP_ENV.tokenPath]?.trim() || CRP_DEFAULT_TOKEN_PATH,
  );

  return {
    baseUrl,
    username,
    password,
    tokenPath,
    timeoutMs: CRP_DEFAULT_TIMEOUT_MS,
    retries: CRP_DEFAULT_RETRIES,
  };
}
