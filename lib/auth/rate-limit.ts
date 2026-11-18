/**
 * 登录失败限流：同一账号 1 分钟内最多 5 次失败。
 *
 * 只统计失败次数，成功登录把该账号的计数清零；次数超了返回 429 并给出重试等待时间。
 *
 * 计数表的键来自**未登录请求**（请求体里的邮箱），所以它必须自带边界，否则谁都能用一堆随机邮箱
 * 把内存撑爆：
 *
 * - 键长度截断到 254 个字符（邮箱规范上限），超长邮箱不会按原串占内存；
 * - 表有容量上限，写满后淘汰最早写入的键（`Map` 的插入顺序）；
 * - 每过一个窗口全量清扫一次过期键，长时间没人访问的键不会永久驻留。
 *
 * 计数放在进程内存里：PRD 约定本平台单实例运行（定时任务与 Web 服务同进程），
 * 多实例部署时要换成共享存储，否则每个实例各算一份。
 *
 * 纯逻辑模块：时间由调用方传入，不在内部读时钟，方便单测。
 */

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export type LoginRateLimiter = {
  /** 只看不记：当前是否还能尝试。 */
  check(key: string, now: Date): RateLimitDecision;
  /** 记一次失败。 */
  recordFailure(key: string, now: Date): void;
  /** 登录成功后清零。 */
  reset(key: string): void;
  /** 还在计数的键数量。给「回收策略」的单测用，也便于以后加监控。 */
  size(): number;
};

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 60 * 1000;

/** 计数表最多保留多少个键。写满后淘汰最早的键，内存因此有上限。 */
export const LOGIN_FAILURE_MAX_KEYS = 5_000;

/** 键的最大长度，与邮箱地址的长度上限一致（RFC 5321 的 254 字符）。 */
const MAX_KEY_LENGTH = 254;

export function createLoginRateLimiter(
  options: { limit?: number; windowMs?: number; maxKeys?: number } = {},
): LoginRateLimiter {
  const limit = options.limit ?? LOGIN_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_MS;
  const maxKeys = options.maxKeys ?? LOGIN_FAILURE_MAX_KEYS;
  const failures = new Map<string, number[]>();
  let lastSweepAt = 0;

  /** 超长键截断，避免请求体决定内存占用。 */
  function keyOf(raw: string): string {
    return raw.slice(0, MAX_KEY_LENGTH);
  }

  /** 丢掉某个键窗口外的时间戳；一条不剩时删掉这个键。 */
  function prune(key: string, now: Date): number[] {
    const cutoff = now.getTime() - windowMs;
    const kept = (failures.get(key) ?? []).filter((at) => at > cutoff);

    if (kept.length === 0) {
      failures.delete(key);
    } else {
      failures.set(key, kept);
    }

    return kept;
  }

  /** 全量清扫：每次最多过一个窗口执行一次，把没人再访问的旧键删掉。 */
  function sweep(now: Date): void {
    if (now.getTime() - lastSweepAt < windowMs) {
      return;
    }

    lastSweepAt = now.getTime();
    const cutoff = now.getTime() - windowMs;

    for (const [key, stamps] of failures) {
      const kept = stamps.filter((at) => at > cutoff);

      if (kept.length === 0) {
        failures.delete(key);
      } else {
        failures.set(key, kept);
      }
    }
  }

  /** 淘汰最早写入的键（`Map` 按插入顺序迭代）。 */
  function evictOldest(): void {
    const oldest = failures.keys().next();

    if (!oldest.done) {
      failures.delete(oldest.value);
    }
  }

  return {
    check(key, now) {
      const kept = prune(keyOf(key), now);

      if (kept.length < limit) {
        return { allowed: true };
      }

      const oldest = kept[0] ?? now.getTime();
      return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now.getTime()) };
    },

    recordFailure(key, now) {
      const normalized = keyOf(key);
      sweep(now);

      // 新键进来前先确保还有位置：过期键已经被 sweep 清掉，仍然满就淘汰最早的。
      if (!failures.has(normalized) && failures.size >= maxKeys) {
        evictOldest();
      }

      const kept = prune(normalized, now);
      kept.push(now.getTime());
      failures.set(normalized, kept);
    },

    reset(key) {
      failures.delete(keyOf(key));
    },

    size() {
      return failures.size;
    },
  };
}
