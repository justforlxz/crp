/**
 * 接口与定时任务入口共用的 Bearer token 校验。
 *
 * 外部系统与定时器都没有浏览器会话，只能靠请求头里的 token 证明身份。规则与 `lib/auth`
 * 的会话无关：token 只从环境变量读，不为它建表。
 *
 * 两条不能省：
 *
 * 1. 比较走定长比较，不按字节提前返回，避免泄漏 token 前缀。
 * 2. 没配置 token 时一律拒绝（fail closed）：配置缺失不能被当成「谁都能调」。
 */

import { timingSafeEqual } from "node:crypto";

export type BearerAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_token" | "invalid_token" };

/** 读出配置的 token；没配或只有空白都返回 `null`。 */
export function readBearerToken(
  envName: string,
  source: Record<string, string | undefined> = process.env,
): string | null {
  const token = source[envName]?.trim();
  return token ? token : null;
}

/** 定长比较，避免按字节提前返回泄漏 token 前缀。 */
export function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/** 校验请求头里的 `Authorization: Bearer <token>`。 */
export function checkBearerAuth(
  request: Request,
  expected: string | null,
): BearerAuthResult {
  if (!expected) {
    return { ok: false, reason: "not_configured" };
  }

  const header = request.headers.get("authorization")?.trim() ?? "";
  const matched = /^Bearer\s+(.+)$/i.exec(header);

  if (!matched) {
    return { ok: false, reason: "missing_token" };
  }

  return sameToken(matched[1].trim(), expected)
    ? { ok: true }
    : { ok: false, reason: "invalid_token" };
}
