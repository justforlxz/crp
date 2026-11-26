/**
 * `user_credential` 表的读写。
 *
 * 两套读法，差别是**要不要带密文**：
 *
 * - `listCredentialSummaries()`：页面与接口用。只挑展示需要的四列，密文列根本不进内存，
 *   所以「接口不回传密码」（CRED-2）不是靠上层记得过滤，而是这里读不到。
 * - `findStoredCredential()`：真正要调外部系统时用。带上密文三件套，交给 cipher 解密。
 */

import type { SealedSecret } from "./cipher";
import type { CredentialKindName } from "./kinds";

/** 只在要解密时读的完整行。字段名就是表的列名，解密前由 `toSealedRow()` 改名。 */
export type StoredCredential = {
  userId: string;
  kind: CredentialKindName;
  username: string;
  secretCiphertext: string;
  secretIv: string;
  secretTag: string;
  keyVersion: number;
};

/** 页面能看到的四样：配没配、账号名、最后验证时间、最后错误。 */
export type CredentialSummaryRow = {
  kind: CredentialKindName;
  username: string;
  verifiedAt: Date | null;
  lastError: string | null;
};

/**
 * 懒加载 Prisma 客户端。
 *
 * 这里用动态 import 而不是顶层 import：凭据要读库，但这个模块被 CRP 与 Gerrit 客户端引用，
 * 而客户端的单测是纯逻辑、不需要数据库。顶层 import 会让「只要 import 客户端就要求
 * DATABASE_URL」，那些单测会被迫依赖一个自己用不上的数据库。
 */
async function db() {
  const { prisma } = await import("../db");

  return prisma;
}

const SEALED_SELECT = {
  userId: true,
  kind: true,
  username: true,
  secretCiphertext: true,
  secretIv: true,
  secretTag: true,
  keyVersion: true,
} as const;

const SUMMARY_SELECT = {
  kind: true,
  username: true,
  verifiedAt: true,
  lastError: true,
} as const;

/** 这个人的这一类凭据；没有返回 `null`。 */
export async function findStoredCredential(
  userId: string,
  kind: CredentialKindName,
): Promise<StoredCredential | null> {
  const row = await (await db()).userCredential.findUnique({
    where: { userId_kind: { userId, kind } },
    select: SEALED_SELECT,
  });

  return row === null ? null : { ...row, kind: row.kind as CredentialKindName };
}

/** 这个人已配置的凭据摘要，按库里的顺序返回（每种系统最多一条）。 */
export async function listCredentialSummaries(
  userId: string,
): Promise<CredentialSummaryRow[]> {
  const rows = await (await db()).userCredential.findMany({
    where: { userId },
    select: SUMMARY_SELECT,
  });

  return rows.map((row) => ({ ...row, kind: row.kind as CredentialKindName }));
}

/** 这个人某一类凭据是否存在。不解密，只查有没有。 */
export async function hasStoredCredential(
  userId: string,
  kind: CredentialKindName,
): Promise<boolean> {
  const count = await (await db()).userCredential.count({ where: { userId, kind } });

  return count > 0;
}

/**
 * 写入或覆盖一份凭据。
 *
 * 一个人每种系统只能有一份（`(user_id, kind)` 唯一），所以第二次保存就是覆盖：
 * 覆盖时 `created_at` 不动，`verified_at` 与 `last_error` 一起刷新。
 */
export async function upsertCredential(input: {
  userId: string;
  kind: CredentialKindName;
  username: string;
  sealed: SealedSecret;
  verifiedAt: Date;
}): Promise<void> {
  const data = {
    username: input.username,
    secretCiphertext: input.sealed.ciphertext,
    secretIv: input.sealed.iv,
    secretTag: input.sealed.tag,
    keyVersion: input.sealed.keyVersion,
    verifiedAt: input.verifiedAt,
    lastError: null,
  };

  await (await db()).userCredential.upsert({
    where: { userId_kind: { userId: input.userId, kind: input.kind } },
    create: { userId: input.userId, kind: input.kind, ...data },
    update: data,
  });
}

/**
 * 把一次验证失败的原因记到已有记录上。
 *
 * 只改 `lastError`，不动账号名与密文：验证没通过就换掉旧凭据，等于把人正在用的
 * 那份一并删了，而他只是这次填错了。新凭据（还没有记录）不写这一行 ——
 * CRED-3 要求验证失败时表里没有新增记录。
 */
export async function markVerifyFailure(
  userId: string,
  kind: CredentialKindName,
  reason: string,
): Promise<void> {
  await (await db()).userCredential.updateMany({
    where: { userId, kind },
    data: { lastError: reason.slice(0, 500) },
  });
}

/** 删掉一份凭据；返回删了几行（0 表示本来就没有）。 */
export async function deleteCredentialRow(
  userId: string,
  kind: CredentialKindName,
): Promise<number> {
  const result = await (await db()).userCredential.deleteMany({ where: { userId, kind } });

  return result.count;
}
