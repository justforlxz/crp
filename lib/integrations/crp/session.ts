/**
 * 登录态：拿 token、按人缓存 token、401 之后换新 token。
 *
 * CRP 的 token 是一个 JWT，只有 `exp` 与 `name` 两个声明，实测有效期 3 天。
 * 缓存只放进程内存，键是账号 ID（见 `tokenCache.ts`）：同一个进程里 A 与 B 各拿各的令牌，
 * 不会互相串。这里只管生命周期，不管请求怎么发——真正的登录请求由调用方注入
 * （`postLogin`），这样重试与错误分类留在请求层。
 */

import { missingCredentialMessage } from "../../credentials/errors";
import { encryptPassword } from "./auth";
import { CrpAuthError, CrpInvalidParameterError, responseSnippet } from "./errors";
import { readCachedToken, writeCachedToken } from "./tokenCache";

export type CrpSessionOptions = {
  /** LDAP 账号；未配置时只能用传入的 token。 */
  username?: string;
  /** LDAP 密码；未配置时只能用传入的 token。 */
  password?: string;
  /** 已有的 token，优先使用。 */
  token?: string;
  /** 进程内令牌缓存的键（账号 ID）；`null` 表示不缓存。 */
  tokenKey: string | null;
  /** 当前时间（毫秒），便于测试。 */
  now: () => number;
  /** 发登录请求；由请求层注入，所以登录也享受重试与错误分类。 */
  postLogin: (body: { userName: string; password: string }) => Promise<{ Token?: unknown }>;
};

export type CrpSession = {
  /** 真登录一次，刷新 token 并写缓存。 */
  login(): Promise<string>;
  /** 有可用 token 就用，没有才登录。 */
  authorize(): Promise<string>;
  /** 丢掉当前 token（401 之后调用）。 */
  reset(): void;
  /** 是否具备登录所需的凭据。 */
  canLogin(): boolean;
};

export function createCrpSession(options: CrpSessionOptions): CrpSession {
  const username = options.username?.trim();
  const password = options.password;
  const tokenKey = options.tokenKey;

  let tokenValue = options.token?.trim() || null;

  function canLogin(): boolean {
    return Boolean(username && password);
  }

  async function login(): Promise<string> {
    if (!canLogin()) {
      throw new CrpInvalidParameterError(
        `${missingCredentialMessage("crp")}登录需要 LDAP 账号与密码，` +
          "或给客户端直接传入 token。",
      );
    }

    const parsed = await options.postLogin({
      userName: username as string,
      password: encryptPassword(password as string),
    });

    const token = typeof parsed?.Token === "string" ? parsed.Token.trim() : "";
    if (token === "") {
      throw new CrpAuthError("CRP 登录返回了成功状态，但响应里没有 Token 字段", {
        responseSnippet: responseSnippet(JSON.stringify(parsed)),
      });
    }

    tokenValue = token;
    if (tokenKey !== null) {
      writeCachedToken(tokenKey, token);
    }

    return token;
  }

  async function authorize(): Promise<string> {
    if (tokenValue) {
      return tokenValue;
    }

    if (tokenKey !== null) {
      const cached = readCachedToken(tokenKey, options.now());
      if (cached) {
        tokenValue = cached;
        return cached;
      }
    }

    return login();
  }

  function reset(): void {
    tokenValue = null;
  }

  return { login, authorize, reset, canLogin };
}
