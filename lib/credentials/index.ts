/**
 * 凭据模块的对外入口：`lib/` 之外只从这里 import。
 *
 * 目录分工：
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `kinds.ts` | 种类、页面标题、环境变量名、配置页地址 |
 * | `cipher.ts` | AES-256-GCM 加解密，AAD 绑人，主密钥读取 |
 * | `store.ts` | `user_credential` 表读写（展示用只读四列，解密用才读密文） |
 * | `verify.ts` | 保存前的真实登录验证（CRP / Gerrit） |
 * | `service.ts` | 对外能力：读状态、保存、删除、取明文 |
 * | `current.ts` | 「当前操作人」——前台的默认调用身份 |
 * | `errors.ts` | 五类错误，各自对应一种处理方式 |
 */

export {
  decryptSecret,
  encryptSecret,
  readKeyVersion,
  readMasterKey,
  type MasterKey,
  type SealedRow,
  type SealedSecret,
} from "./cipher";
export {
  CredentialActorError,
  CredentialDecryptError,
  CredentialError,
  CredentialInputError,
  CredentialKeyError,
  CredentialMissingError,
  CredentialVerifyError,
  missingCredentialMessage,
} from "./errors";
export {
  CREDENTIAL_KIND_LABELS,
  CREDENTIAL_KINDS,
  CREDENTIAL_KEY_ENV,
  CREDENTIAL_KEY_VERSION_ENV,
  CREDENTIAL_PAGE_PATH,
  CREDENTIAL_SECRET_LABELS,
  isCredentialKind,
  type CredentialKindName,
} from "./kinds";
export { currentActorUserId } from "./current";
export {
  assertCredentialInput,
  deleteCredential,
  hasCredential,
  listCredentialViews,
  loadCredentialSecret,
  requireCredentialSecret,
  saveCredential,
  toCredentialView,
  type CredentialView,
  type SaveCredentialInput,
  type SaveCredentialOptions,
} from "./service";
export { verifyCredential, verifyCrpLogin, verifyGerritLogin } from "./verify";
