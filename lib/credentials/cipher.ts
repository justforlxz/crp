/**
 * 凭据密文的加解密：AES-256-GCM。
 *
 * 三条约束，每条都对应一种真实的泄露路径：
 *
 * 1. **主密钥只从环境变量来**（`CREDENTIAL_ENCRYPTION_KEY`，32 字节的 base64）。缺了就直接
 *    报错，不退回任何默认值：拿一个写死的密钥加密等于不加密。
 * 2. **AAD 绑定 `userId + kind`**。密文本身是可搬的：把 A 的密文抄进 B 的行，GCM 照样能解出
 *    A 的密码。绑定之后搬过去就解不开（验收 CRED-8）。
 * 3. **三件套一起存**：密文、初始向量、认证标签。少一件都解不出来，也说明这条记录坏过。
 *
 * 明文只在内存里活到这次调用结束：这里不写日志、不拼错误消息、不落盘。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { CredentialDecryptError, CredentialKeyError } from "./errors";
import type { CredentialKindName } from "./kinds";
import { CREDENTIAL_KEY_ENV, CREDENTIAL_KEY_VERSION_ENV } from "./kinds";

/** AES-256-GCM 的密钥长度（字节）。 */
const KEY_BYTES = 32;

/** GCM 的初始向量长度（字节）。12 字节是 GCM 的标准长度，随机生成。 */
const IV_BYTES = 12;

/** 认证标签长度（字节）。 */
const TAG_BYTES = 16;

/** 默认主密钥版本。轮换时由 `CREDENTIAL_ENCRYPTION_KEY_VERSION` 指定新版本号。 */
const DEFAULT_KEY_VERSION = 1;

/** 一次加密的结果，与 `user_credential` 的三列一一对应。 */
export type SealedSecret = {
  /** base64 密文。 */
  ciphertext: string;
  /** base64 初始向量。 */
  iv: string;
  /** base64 认证标签。 */
  tag: string;
  /** 加密时用的主密钥版本。 */
  keyVersion: number;
};

/** 主密钥与它的版本。 */
export type MasterKey = {
  key: Buffer;
  version: number;
};

/** 解密需要的全部输入：库里那一行加上主密钥。 */
export type SealedRow = SealedSecret & {
  userId: string;
  kind: CredentialKindName;
};

/**
 * 读主密钥。
 *
 * 缺失、不是 base64、解出来不是 32 字节，三种情况都抛 `CredentialKeyError`：配错了密钥
 * 和没配一样不能用，而且配错了更危险——会拿一把错误的密钥加密，日后没人解得开。
 */
export function readMasterKey(
  source: Record<string, string | undefined> = process.env,
): MasterKey {
  const raw = source[CREDENTIAL_KEY_ENV]?.trim();

  if (!raw) {
    throw new CredentialKeyError(
      `服务端未配置加密密钥：缺少环境变量 ${CREDENTIAL_KEY_ENV}。` +
        `它是平台密钥（32 字节的 base64），不是某个人的凭据；生成方式见 RUNBOOK。`,
    );
  }

  const key = Buffer.from(raw, "base64");

  if (key.length !== KEY_BYTES) {
    throw new CredentialKeyError(
      `环境变量 ${CREDENTIAL_KEY_ENV} 不是 32 字节的 base64（解出来 ${key.length} 字节），` +
        "无法用于 AES-256-GCM。",
    );
  }

  return { key, version: readKeyVersion(source) };
}

/** 主密钥版本；不填按 1，填了但不是正整数直接报错。 */
export function readKeyVersion(source: Record<string, string | undefined> = process.env): number {
  const raw = source[CREDENTIAL_KEY_VERSION_ENV]?.trim();

  if (!raw) {
    return DEFAULT_KEY_VERSION;
  }

  const version = Number(raw);

  if (!Number.isInteger(version) || version <= 0) {
    throw new CredentialKeyError(
      `环境变量 ${CREDENTIAL_KEY_VERSION_ENV} 必须是正整数，当前是：${raw}。`,
    );
  }

  return version;
}

/**
 * AAD：认证数据本身不加密，但参与认证标签的计算。
 *
 * 用 `\n` 分隔两个字段，避免 `("ab","c")` 与 `("a","bc")` 拼出同一串。
 */
export function credentialAad(userId: string, kind: CredentialKindName): Buffer {
  return Buffer.from(`${userId}\n${kind}`, "utf8");
}

/** 加密一份密码。 `master.key` 只在这一次调用里用到，不缓存、不返回。 */
export function encryptSecret(
  secret: string,
  input: { userId: string; kind: CredentialKindName; master: MasterKey },
): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", input.master.key, iv, {
    authTagLength: TAG_BYTES,
  });

  cipher.setAAD(credentialAad(input.userId, input.kind));

  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: input.master.version,
  };
}

/**
 * 解密一份密码。
 *
 * 失败只有一种可说的原因：这份密文不能用这把密钥、在这个名下解开（密钥版本不符、
 * 密文被挪到别人名下、密文被改过）。消息里不带任何密文片段，也不带明文。
 */
export function decryptSecret(row: SealedRow, master: MasterKey): string {
  if (row.keyVersion !== master.version) {
    throw new CredentialDecryptError(
      `凭据密文的密钥版本是 ${row.keyVersion}，服务端当前是 ${master.version}，` +
        "无法解密。按 RUNBOOK 的主密钥轮换步骤处理。",
    );
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      master.key,
      Buffer.from(row.iv, "base64"),
      { authTagLength: TAG_BYTES },
    );

    decipher.setAAD(credentialAad(row.userId, row.kind));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CredentialDecryptError(
      "凭据密文解密失败：主密钥不匹配，或这条密文不属于当前账号。" +
        "请让本人重新配置一次凭据。",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}
