import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicKey } from "node:crypto";

import {
  CRP_PUBLIC_KEY,
  encryptPassword,
  isJwtExpired,
  readCachedToken,
  writeCachedToken,
} from "../lib/integrations/crp/auth";

/** 造一个只有 exp 声明的 JWT，够用即可。 */
function makeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, name: "tester" })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

/** 临时目录放在家目录下，不用 /tmp。 */
function tempDir(): string {
  const root = join(homedir(), ".cache", "crp-tests");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "auth-"));
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

test("token 缓存写成 0600，内容是可用的 token", () => {
  const dir = tempDir();
  const path = join(dir, "nested", "token");
  const jwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
  try {
    writeCachedToken(path, jwt);

    assert.equal(readFileSync(path, "utf8"), jwt);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readCachedToken(path), jwt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆盖已有缓存文件后权限仍是 0600", () => {
  const dir = tempDir();
  const path = join(dir, "token");
  const jwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
  try {
    writeFileSync(path, "old");
    chmodSync(path, 0o644);

    writeCachedToken(path, jwt);

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readCachedToken(path), jwt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缓存里是过期 token、坏 token 或空文件时返回 null", () => {
  const dir = tempDir();
  const path = join(dir, "token");
  try {
    assert.equal(readCachedToken(path), null);

    writeFileSync(path, makeJwt(1));
    assert.equal(readCachedToken(path), null);

    writeFileSync(path, "   ");
    assert.equal(readCachedToken(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
