/**
 * 会话令牌与过期策略。
 *
 * Cookie 里放的是 32 字节随机数（base64url），库里只存它的 SHA-256：
 * 数据库被读走也换不出可用的 Cookie。会话有效期 7 天，滑动续期——
 * 只要还在用就顺延，续期最多每小时一次，避免每个请求都写一次库。
 *
 * 纯函数模块：不读 Cookie、不查库，时间由调用方传入，方便单测。
 */
import { createHash, randomBytes } from "node:crypto";

/** Cookie 名。名字里不带环境，避免同一浏览器在同一域名下的多个部署互相顶掉会话。 */
export const SESSION_COOKIE_NAME = "crp_session";

/** 会话有效期：7 天。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 续期间隔：剩余时间比「有效期减去这个间隔」还少时顺延，也就是最多每小时写一次库。 */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;

/** 生成会话令牌：32 字节随机数的 base64url，长度 43。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 令牌的入库形式：SHA-256 十六进制。同一令牌永远得到同一结果，用于按值查会话。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 会话是否还能用：被撤销或已过期都不行。 */
export function isSessionUsable(
  session: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): boolean {
  if (session.revokedAt !== null) {
    return false;
  }

  return session.expiresAt.getTime() > now.getTime();
}

/**
 * 滑动续期：该顺延时返回新的过期时间，不需要动时返回 null。
 *
 * 刚建立的会话（剩余时间等于有效期）不动；用了一段时间、剩余时间少于
 * 「有效期 - 续期间隔」就顺延到 `now + 有效期`。
 */
export function slidExpiry(expiresAt: Date, now: Date): Date | null {
  if (expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining > SESSION_TTL_MS - SESSION_SLIDE_INTERVAL_MS) {
    return null;
  }

  return new Date(now.getTime() + SESSION_TTL_MS);
}

/** 新会话的过期时间。 */
export function initialExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/**
 * Cookie 属性：httpOnly 挡住脚本读取，SameSite=Lax 挡住跨站提交，
 * 生产环境再加 Secure。`maxAge` 与库里过期时间一致。
 */
export function sessionCookieOptions(
  expiresAt: Date,
  now: Date,
  secure: boolean,
): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  expires: Date;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  };
}
