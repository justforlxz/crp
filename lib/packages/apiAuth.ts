/**
 * `POST /api/packages` 的鉴权。
 *
 * 用独立 token，不复用用户会话（正文 MUST）：外部系统没有 Cookie，也不该因为某个人
 * 退出登录就断掉。token 放在环境变量 `PACKAGE_API_TOKEN` 里，不为它建表。
 *
 * 没配置 token 时一律拒绝（fail closed）：配置缺失不能被当成「谁都能写」。
 */

import { timingSafeEqual } from "node:crypto";

export const PACKAGE_API_TOKEN_ENV = "PACKAGE_API_TOKEN";

export type ApiAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_token" | "invalid_token" };

/** 读出配置的 token；没配或只有空白都返回 `null`。 */
export function readPackageApiToken(
  source: Record<string, string | undefined> = process.env,
): string | null {
  const token = source[PACKAGE_API_TOKEN_ENV]?.trim();
  return token ? token : null;
}

/** 定长比较，避免按字节提前返回泄漏 token 前缀。 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/** 校验请求头里的 `Authorization: Bearer <token>`。 */
export function checkPackageApiAuth(
  request: Request,
  source: Record<string, string | undefined> = process.env,
): ApiAuthResult {
  const expected = readPackageApiToken(source);

  if (!expected) {
    return { ok: false, reason: "not_configured" };
  }

  const header = request.headers.get("authorization")?.trim() ?? "";
  const matched = /^Bearer\s+(.+)$/i.exec(header);

  if (!matched) {
    return { ok: false, reason: "missing_token" };
  }

  return safeEqual(matched[1].trim(), expected)
    ? { ok: true }
    : { ok: false, reason: "invalid_token" };
}
