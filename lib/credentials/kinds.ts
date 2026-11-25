/**
 * 凭据的种类与对外常量。
 *
 * 只有 CRP 与 Gerrit 两套：Shuttle 的读取接口匿名可用，Webhook 投递用平台自己的签名，
 * 都不需要成员的个人凭据（见 `.agents/spec/product/credentials.md` 第六节）。
 */

/** 一套外部系统。值等于数据库枚举 `credential_kind`。 */
export const CREDENTIAL_KINDS = ["crp", "gerrit"] as const;

export type CredentialKindName = (typeof CREDENTIAL_KINDS)[number];

/** 页面上的区块标题。 */
export const CREDENTIAL_KIND_LABELS: Record<CredentialKindName, string> = {
  crp: "CRP 账号",
  gerrit: "Gerrit 账号",
};

/** 密码这一栏在页面上叫什么。Gerrit 用 HTTP 凭据，不是登录密码。 */
export const CREDENTIAL_SECRET_LABELS: Record<CredentialKindName, string> = {
  crp: "LDAP 密码",
  gerrit: "HTTP 密码",
};

/** 「我的账号」页的地址。未配置的提示里直接给出它。 */
export const CREDENTIAL_PAGE_PATH = "/settings/credentials";

/** 主密钥的环境变量名。它是平台密钥，不是某个人的凭据。 */
export const CREDENTIAL_KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";

/** 主密钥版本的环境变量名。不填按 1；轮换时改成新版本号。 */
export const CREDENTIAL_KEY_VERSION_ENV = "CREDENTIAL_ENCRYPTION_KEY_VERSION";

/** 判断任意字符串是不是一种凭据种类。 */
export function isCredentialKind(value: unknown): value is CredentialKindName {
  return typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}
