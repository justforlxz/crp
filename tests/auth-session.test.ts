import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  initialExpiry,
  isSessionUsable,
  sessionCookieOptions,
  slidExpiry,
} from "../lib/auth/session";

const now = new Date("2026-11-18T12:00:00Z");
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

test("会话令牌是 43 字符的 base64url，两次生成不相同", () => {
  const first = generateSessionToken();
  const second = generateSessionToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("令牌哈希稳定、64 位十六进制，且与令牌本身不同", () => {
  const token = generateSessionToken();
  const hashed = hashSessionToken(token);

  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(token), hashed);
  assert.notEqual(hashed, token);
  assert.notEqual(hashSessionToken(second(token)), hashed);
});

test("会话过期时间：撤销的、过期的、正好到点的都不能用", () => {
  const usable = { expiresAt: at(1000), revokedAt: null };

  assert.equal(isSessionUsable(usable, now), true);
  assert.equal(isSessionUsable({ expiresAt: at(1000), revokedAt: now }, now), false);
  assert.equal(isSessionUsable({ expiresAt: at(-1000), revokedAt: null }, now), false);
  assert.equal(isSessionUsable({ expiresAt: now, revokedAt: null }, now), false);
});

test("滑动续期：刚建立的会话不动，剩余不足一小时时顺延到 now + 7 天", () => {
  const ttl = SESSION_TTL_MS;
  const slide = SESSION_SLIDE_INTERVAL_MS;

  // 刚刚登录：剩余正好一个有效期，不写库。
  assert.equal(slidExpiry(new Date(now.getTime() + ttl), now), null);

  // 用了一小时以内：剩余仍然多于「有效期 - 续期间隔」。
  const fresh = new Date(now.getTime() + ttl - slide / 2);
  assert.equal(slidExpiry(fresh, now), null);

  // 到点该续期：剩余正好等于阈值。
  const due = new Date(now.getTime() + ttl - slide);
  assert.deepEqual(slidExpiry(due, now), new Date(now.getTime() + ttl));

  // 已经过期：不再续期。
  assert.equal(slidExpiry(now, now), null);
});

test("新会话的过期时间就是一个有效期之后", () => {
  assert.equal(initialExpiry(now).getTime(), now.getTime() + SESSION_TTL_MS);
});

test("会话 Cookie 属性：httpOnly、SameSite=Lax、路径 /，maxAge 与过期时间一致", () => {
  const expiresAt = at(SESSION_TTL_MS);
  const options = sessionCookieOptions(expiresAt, now, true);

  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.secure, true);
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, SESSION_TTL_MS / 1000);
  assert.equal(options.expires.getTime(), expiresAt.getTime());

  // 关闭 cookie（maxAge 0）时 maxAge 不会出现负数。
  assert.equal(sessionCookieOptions(now, now, false).maxAge, 0);
});

/** 造一个与入参不同的令牌，用于断言哈希随值变化。 */
function second(token: string): string {
  return token.endsWith("A") ? `${token.slice(0, -1)}B` : `${token.slice(0, -1)}A`;
}
