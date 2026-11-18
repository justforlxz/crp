import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_MAX_KEYS,
  LOGIN_FAILURE_WINDOW_MS,
  createLoginRateLimiter,
} from "../lib/auth/rate-limit";

const start = new Date("2026-11-18T12:00:00Z");
const at = (offsetMs: number): Date => new Date(start.getTime() + offsetMs);

test("同一账号连续 5 次失败后第 6 次被拦，等待时间按最早的失败算", () => {
  const limiter = createLoginRateLimiter();
  const key = "user@example.com";

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    assert.deepEqual(limiter.check(key, at(attempt * 1000)), { allowed: true });
    limiter.recordFailure(key, at(attempt * 1000));
  }

  const blocked = limiter.check(key, at(5000));
  assert.equal(blocked.allowed, false);
  assert.equal(
    blocked.allowed === false ? blocked.retryAfterMs : 0,
    LOGIN_FAILURE_WINDOW_MS - 5000,
  );
});

test("过了窗口期自动恢复，不需要手工清理", () => {
  const limiter = createLoginRateLimiter();
  const key = "user@example.com";

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure(key, at(0));
  }

  assert.equal(limiter.check(key, at(0)).allowed, false);
  assert.equal(limiter.check(key, at(LOGIN_FAILURE_WINDOW_MS)).allowed, true);
});

test("登录成功后清零，下一次失败从头计数", () => {
  const limiter = createLoginRateLimiter();
  const key = "user@example.com";

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure(key, at(0));
  }
  assert.equal(limiter.check(key, at(0)).allowed, false);

  limiter.reset(key);

  assert.equal(limiter.check(key, at(0)).allowed, true);
  limiter.recordFailure(key, at(0));
  assert.equal(limiter.check(key, at(0)).allowed, true);
});

test("不同账号各算各的，互不影响", () => {
  const limiter = createLoginRateLimiter();
  const noisy = "noisy@example.com";
  const quiet = "quiet@example.com";

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure(noisy, at(0));
  }

  assert.equal(limiter.check(noisy, at(0)).allowed, false);
  assert.equal(limiter.check(quiet, at(0)).allowed, true);
});

test("过了窗口再写一次，旧键被清扫掉，不会永久驻留内存", () => {
  const limiter = createLoginRateLimiter();
  const stale1 = "stale-1@example.com";
  const stale2 = "stale-2@example.com";

  limiter.recordFailure(stale1, at(0));
  limiter.recordFailure(stale2, at(0));
  assert.equal(limiter.size(), 2);

  // 窗口过去之后又来一次失败：全量清扫把两个旧键删掉，只留下这次的键。
  limiter.recordFailure("fresh@example.com", at(LOGIN_FAILURE_WINDOW_MS + 1));

  assert.equal(limiter.size(), 1);
  assert.equal(limiter.check(stale1, at(LOGIN_FAILURE_WINDOW_MS + 1)).allowed, true);
});

test("键数量有上限：写满后淘汰最早的键，内存不随尝试次数单调增长", () => {
  const limiter = createLoginRateLimiter({ maxKeys: 2 });
  const first = "first@example.com";

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure(first, at(attempt * 1000));
  }
  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure("second@example.com", at(attempt * 1000));
  }

  assert.equal(limiter.size(), 2);
  assert.equal(limiter.check(first, at(5000)).allowed, false);

  // 第三个键挤进来，最早的键被淘汰，表大小保持不变。
  limiter.recordFailure("third@example.com", at(6000));

  assert.equal(limiter.size(), 2);
  assert.equal(limiter.check(first, at(6000)).allowed, true);
  assert.equal(limiter.check("third@example.com", at(6000)).allowed, true);
});

test("超长键按 254 字符截断：同一前缀算同一个键，不按原串占内存", () => {
  const limiter = createLoginRateLimiter();
  const long = "a".repeat(300);

  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
    limiter.recordFailure(long, at(attempt * 1000));
  }

  assert.equal(limiter.size(), 1);
  assert.equal(limiter.check("a".repeat(254), at(5000)).allowed, false);
  assert.equal(limiter.check("a".repeat(253), at(5000)).allowed, true);
});

test("默认阈值就是 5 次 / 60 秒", () => {
  assert.equal(LOGIN_FAILURE_LIMIT, 5);
  assert.equal(LOGIN_FAILURE_WINDOW_MS, 60_000);
  assert.equal(LOGIN_FAILURE_MAX_KEYS, 5_000);
});
