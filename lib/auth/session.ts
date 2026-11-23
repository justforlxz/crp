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
 * 走 https 时再加 Secure（由 `isSecureRequest()` 按请求协议判断）。`maxAge` 与库里过期时间一致。
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

/** 显式覆盖 Cookie 的 `Secure` 属性。内网 http 部署把它设成 `false`。 */
export const SESSION_COOKIE_SECURE_ENV = "SESSION_COOKIE_SECURE";

/**
 * 读 `SESSION_COOKIE_SECURE` 的取值：`true` / `false`（首尾空白与大小写不敏感）。
 *
 * 未设置、空串或取值不认识时返回 `null`，表示「按请求协议自动判断」。
 */
export function secureCookieOverride(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

/**
 * 请求是否走 https —— 决定 Cookie 带不带 `Secure`。
 *
 * 顺序：`SESSION_COOKIE_SECURE` 显式覆盖 → `x-forwarded-proto`（反向代理知道真实协议，
 * 代理追加多段时取第一段）→ 请求 URL 的协议。三个信号都没有时按 http 处理。
 *
 * 不看 `NODE_ENV`：`pnpm start` 下它恒为 production，但 http 部署的浏览器会直接丢掉带
 * `Secure` 的 Cookie，登录后立刻变回未认证。也不看 `HOST`、端口号之类的间接信号。
 */
export function isSecureRequest(
  url: string | null,
  forwardedProto: string | null,
  override: string | undefined,
): boolean {
  const explicit = secureCookieOverride(override);

  if (explicit !== null) {
    return explicit;
  }

  const forwarded = forwardedProto?.split(",")[0]?.trim().toLowerCase();

  if (forwarded === "https") {
    return true;
  }

  if (forwarded === "http") {
    return false;
  }

  return url !== null && new URL(url).protocol === "https:";
}
