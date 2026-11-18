/**
 * 登录态：拿 token、缓存 token、401 之后换新 token。
 *
 * CRP 的 token 是一个 JWT，只有 `exp` 与 `name` 两个声明，实测有效期 3 天。
 * 缓存写在磁盘上，权限 0600，所以这里只管生命周期，不管请求怎么发——
 * 真正的登录请求由调用方注入（`postLogin`），这样重试与错误分类留在请求层。
 */

import { encryptPassword, readCachedToken, writeCachedToken } from "./auth";
import { CrpAuthError, CrpInvalidParameterError, responseSnippet } from "./errors";

export type CrpSessionOptions = {
  /** LDAP 账号；未配置时只能用传入的 token。 */
  username?: string;
  /** LDAP 密码；未配置时只能用传入的 token。 */
  password?: string;
  /** 已有的 token，优先使用。 */
  token?: string;
  /** 缓存文件路径；`null` 表示不落盘。 */
  tokenPath: string | null;
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
  const tokenPath = options.tokenPath;

  let tokenValue = options.token?.trim() || null;

  function canLogin(): boolean {
    return Boolean(username && password);
  }

  async function login(): Promise<string> {
    if (!canLogin()) {
      throw new CrpInvalidParameterError(
        "登录需要 LDAP 账号与密码：请设置 CRP_USERNAME 与 CRP_PASSWORD 环境变量，" +
          "或给客户端传入 token。",
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
    if (tokenPath) {
      writeCachedToken(tokenPath, token);
    }

    return token;
  }

  async function authorize(): Promise<string> {
    if (tokenValue) {
      return tokenValue;
    }

    if (tokenPath) {
      const cached = readCachedToken(tokenPath, options.now());
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
