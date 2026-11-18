/**
 * `POST /api/packages` 的鉴权。
 *
 * 用独立 token，不复用用户会话（正文 MUST）：外部系统没有 Cookie，也不该因为某个人
 * 退出登录就断掉。token 放在环境变量 `PACKAGE_API_TOKEN` 里，不为它建表。
 *
 * 没配置 token 时一律拒绝（fail closed）：配置缺失不能被当成「谁都能写」。
 * 校验逻辑本身在 `lib/auth/bearer.ts`，与定时任务入口共用一份。
 */

import {
  checkBearerAuth,
  readBearerToken,
  type BearerAuthResult,
} from "../auth/bearer";

export const PACKAGE_API_TOKEN_ENV = "PACKAGE_API_TOKEN";

export type ApiAuthResult = BearerAuthResult;

/** 读出配置的 token；没配或只有空白都返回 `null`。 */
export function readPackageApiToken(
  source: Record<string, string | undefined> = process.env,
): string | null {
  return readBearerToken(PACKAGE_API_TOKEN_ENV, source);
}

/** 校验请求头里的 `Authorization: Bearer <token>`。 */
export function checkPackageApiAuth(
  request: Request,
  source: Record<string, string | undefined> = process.env,
): ApiAuthResult {
  return checkBearerAuth(request, readPackageApiToken(source));
}
