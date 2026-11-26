/**
 * CRP 登录令牌的进程内缓存，按人分键。
 *
 * 契约（`.agents/spec/product/credentials.md` 第七节）要求令牌按人缓存，不再所有人共用
 * 一个 `~/.cache/crp/jwt` 文件：
 *
 * - 共用文件时，A 登录写进去，B 拿到的是 A 的令牌 —— 请求会以 A 的名义发出，审计链断在
 *   最不该断的地方。
 * - 落盘本身收益很低（令牌有效期只有几天），泄露风险却不小，所以只放进程内存。
 *
 * 进程重启后所有人都要重新登录一次，这是可以接受的代价：登录一次是秒级操作。
 * 多实例部署时每个实例各存各的，同样只是多登录几次。
 */

import { isJwtExpired } from "./auth";

/** 键是账号 ID；值是 CRP 的 JWT。 */
const tokens = new Map<string, string>();

/** 读某个人的缓存令牌；没有或已过期返回 `null`，过期的顺手丢掉。 */
export function readCachedToken(key: string, nowMs: number = Date.now()): string | null {
  const token = tokens.get(key);

  if (token === undefined) {
    return null;
  }

  if (isJwtExpired(token, nowMs)) {
    tokens.delete(key);
    return null;
  }

  return token;
}

/** 记下某个人的令牌。 */
export function writeCachedToken(key: string, token: string): void {
  tokens.set(key, token);
}

/** 丢掉某个人的令牌（401 之后换新、或本人删了凭据都要丢）。 */
export function clearCachedToken(key: string): void {
  tokens.delete(key);
}

/** 清空全部缓存。只在单测与进程收尾时用，业务代码不要调用。 */
export function clearAllCachedTokens(): void {
  tokens.clear();
}
