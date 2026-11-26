import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey } from "node:crypto";

import {
  CRP_PUBLIC_KEY,
  encryptPassword,
  isJwtExpired,
} from "../lib/integrations/crp/auth";
import {
  clearAllCachedTokens,
  clearCachedToken,
  readCachedToken,
  writeCachedToken,
} from "../lib/integrations/crp/tokenCache";

/** 造一个只有 exp 声明的 JWT，够用即可。 */
function makeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, name: "tester" })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

/** 一小时后过期的 token。 */
function freshJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) + 3600);
}

test("加密结果是 1024 位密钥的一个块，且 base64 可解码", () => {
  const buffer = Buffer.from(encryptPassword("pw-123"), "base64");

  // 1024 位 RSA 的密文固定 128 字节。结构（PKCS#1 v1.5 的填充字节）
  // 只存在于解密后的明文里，密文本身是均匀随机的，所以这里不检查首字节。
  assert.equal(buffer.length, 128);
});

test("同一密码每次加密结果不同，不会因为确定性而泄漏", () => {
  assert.notEqual(encryptPassword("same-password"), encryptPassword("same-password"));
});

test("内联的公钥是一把可用的 1024 位 RSA 公钥", () => {
  const key = createPublicKey(CRP_PUBLIC_KEY);

  assert.equal(key.asymmetricKeyType, "rsa");
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 1024);
});

test("token 未到 exp 时视为有效，留出 60 秒余量", () => {
  const now = 1_700_000_000_000;

  assert.equal(isJwtExpired(makeJwt(1_700_000_000 + 120), now), false);
  assert.equal(isJwtExpired(makeJwt(1_700_000_000 + 30), now), true);
});

test("结构不是 JWT 时按过期处理，不把坏 token 发出去", () => {
  assert.equal(isJwtExpired("not-a-jwt", Date.now()), true);
  assert.equal(isJwtExpired("", Date.now()), true);
});

test("令牌按人分键：两个人各拿各的，互不覆盖", () => {
  clearAllCachedTokens();
  const jwtA = freshJwt();
  const jwtB = freshJwt();

  try {
    writeCachedToken("user-a", jwtA);
    writeCachedToken("user-b", jwtB);

    assert.equal(readCachedToken("user-a"), jwtA);
    assert.equal(readCachedToken("user-b"), jwtB);
  } finally {
    clearAllCachedTokens();
  }
});

test("没有缓存的账号返回 null，不会拿到别人的令牌", () => {
  clearAllCachedTokens();
  const jwt = freshJwt();

  try {
    writeCachedToken("user-a", jwt);

    assert.equal(readCachedToken("user-b"), null);
    assert.equal(readCachedToken("never-cached"), null);
  } finally {
    clearAllCachedTokens();
  }
});

test("过期或结构不对的令牌读出来是 null，并顺手从缓存里丢掉", () => {
  clearAllCachedTokens();

  try {
    writeCachedToken("user-a", makeJwt(1));
    assert.equal(readCachedToken("user-a"), null);

    writeCachedToken("user-b", "not-a-jwt");
    assert.equal(readCachedToken("user-b"), null);
  } finally {
    clearAllCachedTokens();
  }
});

test("清掉一个人的令牌不牵连别人", () => {
  clearAllCachedTokens();
  const jwtA = freshJwt();
  const jwtB = freshJwt();

  try {
    writeCachedToken("user-a", jwtA);
    writeCachedToken("user-b", jwtB);

    clearCachedToken("user-a");

    assert.equal(readCachedToken("user-a"), null);
    assert.equal(readCachedToken("user-b"), jwtB);
  } finally {
    clearAllCachedTokens();
  }
});
