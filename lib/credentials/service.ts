/**
 * 凭据的对外能力：读状态、保存（先验证）、删除、以及给调用方取一份可用的明文。
 *
 * 三条贯穿本模块的约定：
 *
 * 1. **对外只给四样**：是否已配置、账号名、最后验证时间、最后错误。密文与明文都不出现在
 *    返回值里（CRED-2）。
 * 2. **保存前先真实登录**：验证没通过不写库，失败原因原样抛给调用方（CRED-3）。
 * 3. **未配置与解密失败分开报**：前者给「去配置页」的指引并不发外部请求（CRED-6），
 *    后者说明密钥或密文出了问题，需要本人重配。
 */

import { readBaseUrl } from "../integrations/endpoints";
import { clearCachedToken } from "../integrations/crp/tokenCache";
import {
  decryptSecret,
  encryptSecret,
  readMasterKey,
  type MasterKey,
} from "./cipher";
import {
  CredentialInputError,
  CredentialMissingError,
  CredentialVerifyError,
} from "./errors";
import {
  CREDENTIAL_KIND_LABELS,
  CREDENTIAL_KINDS,
  isCredentialKind,
  type CredentialKindName,
} from "./kinds";
import {
  deleteCredentialRow,
  findStoredCredential,
  hasStoredCredential,
  listCredentialSummaries,
  markVerifyFailure,
  upsertCredential,
  type CredentialSummaryRow,
} from "./store";
import { verifyCredential } from "./verify";

/** 页面上一个区块要显示的全部内容。 */
export type CredentialView = {
  kind: CredentialKindName;
  /** 区块标题，例如「CRP 账号」。 */
  label: string;
  configured: boolean;
  /** 已配置的账号名；没配置为 `null`。 */
  username: string | null;
  /** 最后一次验证成功的时间；没配置或从未成功过为 `null`。 */
  verifiedAt: Date | null;
  /** 最后一次验证失败的原因；一直没失败过为 `null`。 */
  lastError: string | null;
};

/** 把库里的一行（或没有行）翻成页面形态。密码相关字段一律不出现。 */
export function toCredentialView(
  kind: CredentialKindName,
  row: CredentialSummaryRow | null,
): CredentialView {
  return {
    kind,
    label: CREDENTIAL_KIND_LABELS[kind],
    configured: row !== null,
    username: row?.username ?? null,
    verifiedAt: row?.verifiedAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

/** 两类凭据的当前状态，顺序固定（CRP 在前，Gerrit 在后），页面直接按顺序渲染。 */
export async function listCredentialViews(userId: string): Promise<CredentialView[]> {
  const rows = await listCredentialSummaries(userId);
  const byKind = new Map(rows.map((row) => [row.kind, row]));

  return CREDENTIAL_KINDS.map((kind) => toCredentialView(kind, byKind.get(kind) ?? null));
}

export type SaveCredentialInput = {
  userId: string;
  kind: CredentialKindName;
  username: string;
  /** 密码明文。只在这一次调用里活着，不落库、不回传。 */
  secret: string;
};

export type SaveCredentialOptions = {
  /** 注入用；单测换成假 fetch，不真的登录外部系统。 */
  fetchImpl?: typeof fetch;
  /** 注入用；覆盖验证请求的地址。 */
  baseUrl?: string;
  /** 注入用；覆盖环境变量来源。 */
  env?: Record<string, string | undefined>;
  /** 注入用；覆盖「现在」。 */
  now?: () => Date;
};

/**
 * 保存一份凭据：先真实验证，通过才入库。
 *
 * 顺序是刻意的：先确认主密钥能用（配错了连保存都做不到，没必要先去打扰外部系统），
 * 再真登录一次，最后才加密入库。任何一步失败都不会留下半份凭据。
 *
 * 验证失败时，如果这个人本来就有凭据，只把失败原因记到 `lastError`，不动账号名与密文 ——
 * 他可能只是这次填错了密码，旧凭据不该被一次手误清掉。
 */
export async function saveCredential(
  input: SaveCredentialInput,
  options: SaveCredentialOptions = {},
): Promise<CredentialView> {
  const username = input.username.trim();

  assertCredentialInput(input.kind, username, input.secret);

  const env = options.env ?? process.env;
  const master = readMasterKey(env);
  const baseUrl = options.baseUrl ?? readBaseUrl(input.kind, env);

  try {
    await verifyCredential(input.kind, username, input.secret, {
      fetchImpl: options.fetchImpl,
      baseUrl,
    });
  } catch (error) {
    if (error instanceof CredentialVerifyError) {
      await markVerifyFailure(input.userId, input.kind, error.reason);
    }

    throw error;
  }

  // 时间在验证通过之后才取：一次验证最长 20 秒，先取会把「最后验证时间」记成开始验证的时刻。
  const now = options.now?.() ?? new Date();
  const sealed = encryptSecret(input.secret, {
    userId: input.userId,
    kind: input.kind,
    master,
  });

  await upsertCredential({
    userId: input.userId,
    kind: input.kind,
    username,
    sealed,
    verifiedAt: now,
  });

  // 凭据换了（换账号、改密码）就必须丢掉这个人已缓存的 CRP 令牌：令牌有效期实测 3 天，
  // 留着它，后续建 Topic / 投递 / 轮询会继续以**旧账号**的身份发出，CRP 侧记录的操作人
  // 是旧账号且不报错 —— 这正是本单要消除的「审计链断掉」，而且无从察觉。
  invalidateTokenCache(input.userId, input.kind);

  return toCredentialView(input.kind, {
    kind: input.kind,
    username,
    verifiedAt: now,
    lastError: null,
  });
}

/** 本地校验：账号名与密码都不能是空的。 */
export function assertCredentialInput(
  kind: CredentialKindName,
  username: string,
  secret: string,
): void {
  if (!isCredentialKind(kind)) {
    throw new CredentialInputError(`不认识的凭据种类：${String(kind)}。`);
  }

  if (username === "") {
    throw new CredentialInputError(`${CREDENTIAL_KIND_LABELS[kind]}的账号名不能为空。`);
  }

  if (secret.trim() === "") {
    throw new CredentialInputError(`${CREDENTIAL_KIND_LABELS[kind]}的密码不能为空。`);
  }
}

/**
 * 凭据变了就丢掉这个人的 CRP 令牌缓存。
 *
 * 只对 CRP 有意义：Gerrit 每次请求都现拼 Basic 头，没有可复用的令牌；顺手清也无害，
 * 但没必要为此写分支，所以按种类判断一下，避免「删了 Gerrit 凭据却清掉 CRP 令牌」
 * 这种看起来对、实际多余的副作用。
 */
function invalidateTokenCache(userId: string, kind: CredentialKindName): void {
  if (kind === "crp") {
    clearCachedToken(userId);
  }
}

/** 删掉一份凭据。本来就没有也算成功：重复删除不该报错。 */
export async function deleteCredential(
  userId: string,
  kind: CredentialKindName,
): Promise<void> {
  await deleteCredentialRow(userId, kind);

  // 删了凭据之后进程里还留着旧令牌，等于「删了账号却还在用它的身份」，必须一起丢掉。
  invalidateTokenCache(userId, kind);
}

/** 这个人这一类凭据是否存在；只查有没有，不解密。 */
export async function hasCredential(
  userId: string,
  kind: CredentialKindName,
): Promise<boolean> {
  return hasStoredCredential(userId, kind);
}

/**
 * 取出可用的明文凭据；没配置返回 `null`。
 *
 * 主密钥缺失或密文解不开会抛错：那不是「没配置」，静默返回 `null` 会让人以为
 * 用户从没配过，去配置页重填一遍也没用。
 */
export async function loadCredentialSecret(
  userId: string,
  kind: CredentialKindName,
  source: Record<string, string | undefined> = process.env,
): Promise<{ username: string; secret: string } | null> {
  const row = await findStoredCredential(userId, kind);

  if (row === null) {
    return null;
  }

  const master: MasterKey = readMasterKey(source);
  const secret = decryptSecret(
    {
      userId: row.userId,
      kind: row.kind,
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    },
    master,
  );

  return { username: row.username, secret };
}

/**
 * 取出可用的明文凭据；没配置直接抛 `CredentialMissingError`。
 *
 * 调用方在外面通常还要先把这句话显示出来并**不发任何外部请求**（CRED-6）：
 * 抛错发生在建客户端之前，请求自然发不出去。
 */
export async function requireCredentialSecret(
  userId: string,
  kind: CredentialKindName,
  source: Record<string, string | undefined> = process.env,
): Promise<{ username: string; secret: string }> {
  const credential = await loadCredentialSecret(userId, kind, source);

  if (credential === null) {
    throw new CredentialMissingError(kind);
  }

  return credential;
}

