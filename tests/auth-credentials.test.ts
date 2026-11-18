import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_MAX_LENGTH,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from "../lib/auth/credentials";

test("同一密码两次哈希结果不同，且两次都能校验通过（AC5）", async () => {
  const first = await hashPassword("correct-horse");
  const second = await hashPassword("correct-horse");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, "correct-horse"), true);
  assert.equal(await verifyPassword(second, "correct-horse"), true);
});

test("哈希串是带参数与盐的 Argon2id 编码串，不是裸摘要", async () => {
  const encoded = await hashPassword("another-secret");

  assert.match(encoded, /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
});

test("密码错误时校验失败，且哈希串里不出现明文密码", async () => {
  const encoded = await hashPassword("plain-text-needle");

  assert.equal(await verifyPassword(encoded, "plain-text-needl"), false);
  assert.equal(await verifyPassword(encoded, ""), false);
  assert.equal(encoded.includes("plain-text-needle"), false);
});

test("不是 Argon2 的哈希串（种子里那种占位串）校验返回 false，不抛异常", async () => {
  assert.equal(await verifyPassword("seed-not-a-real-hash-admin", "anything"), false);
  assert.equal(await verifyPassword("", "anything"), false);
  assert.equal(await verifyPassword("$argon2id$broken", "anything"), false);
});

test("空密码不能哈希", async () => {
  await assert.rejects(() => hashPassword(""), /密码不能为空/);
});

test("密码长度规则：少于 8 位拒绝，正好 8 位通过", () => {
  assert.equal(validatePassword("1234567"), "密码至少 8 个字符");
  assert.equal(validatePassword("12345678"), null);
});

test("邮箱归一化去空白并转小写，格式校验只认单个 @ 且域名含点", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");

  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("USER@Example.com"), true);
  assert.equal(isValidEmail("user@example"), false);
  assert.equal(isValidEmail("user@@example.com"), false);
  assert.equal(isValidEmail("@example.com"), false);
  assert.equal(isValidEmail("user@"), false);
  assert.equal(isValidEmail("user name@example.com"), false);
});

test("邮箱长度上限 254 字符：超长串按格式错误处理，不进查库与限流", () => {
  const local = "a".repeat(EMAIL_MAX_LENGTH - "@example.com".length);
  const tooLong = "a".repeat(EMAIL_MAX_LENGTH - "@example.com".length + 1);

  assert.equal(EMAIL_MAX_LENGTH, 254);
  assert.equal(isValidEmail(`${local}@example.com`), true);
  assert.equal(isValidEmail(`${tooLong}@example.com`), false);
  assert.equal(isValidEmail("a".repeat(10_000)), false);
});
