/**
 * CRP 登录用的密码加密、JWT 有效期判断与 token 缓存。
 *
 * CRP 的登录只认「RSA 加密后 base64」的密码。加密用的是 CRP 自己发布在前端代码里的
 * 公钥（对所有人可见，不是凭据），所以这里直接内联；账号与密码本身只从环境变量读。
 *
 * 真实的登录请求与响应见同目录 FINDINGS.md。
 */

import { constants, publicEncrypt } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** CRP 前端使用的 RSA 公钥，1024 位，PKCS#1 v1.5 填充。 */
export const CRP_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCkA9WqirWQII3D8/M9UG8X8ybQ
Ou+cPSNTgR9b4HenJ7A5zSfkXZnetb5q6MmKTJLGCl9MSsHveQPHmLGDG+xw2MlB
w3Yefd/jJ1Cg8pP69wlHRX+wiyh5p8KY55ehFNsQLm3kDGXgVJdtrZn/MiBOlCtE
fe9YvvT0lqy2BtBpaQIDAQAB
-----END PUBLIC KEY-----`;

/** 提前这么多秒就把 token 当作过期，避免请求正好卡在过期瞬间。 */
const EXPIRY_BUFFER_SECONDS = 60;

const TOKEN_FILE_MODE = 0o600;

/**
 * 用 CRP 公钥加密密码并 base64 编码。
 *
 * 填充必须是 PKCS#1 v1.5（`RSA_PKCS1_PADDING`）；CRP 的解密端是 Go 的
 * `rsa.DecryptPKCS1v15`，换成 OAEP 会直接登录失败。
 */
export function encryptPassword(password: string): string {
  const encrypted = publicEncrypt(
    { key: CRP_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  );

  return encrypted.toString("base64");
}

/** 读 JWT 的 `exp` 声明判断是否过期；读不出来时一律当过期。 */
export function isJwtExpired(token: string, nowMs: number = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return true;
  }

  let exp: unknown;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    exp = payload.exp;
  } catch {
    return true;
  }

  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return true;
  }

  return nowMs / 1000 > exp - EXPIRY_BUFFER_SECONDS;
}

/** 读磁盘上的 token 缓存；文件不存在、为空或已过期都返回 null。 */
export function readCachedToken(path: string, nowMs: number = Date.now()): string | null {
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }

  if (!token || isJwtExpired(token, nowMs)) {
    return null;
  }

  return token;
}

/** 把 token 写进缓存文件，权限 0600。目录不存在时先建出来。 */
export function writeCachedToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: TOKEN_FILE_MODE });
  // 文件已存在时 writeFileSync 的 mode 不生效，所以再明确设一次。
  chmodSync(path, TOKEN_FILE_MODE);
}
