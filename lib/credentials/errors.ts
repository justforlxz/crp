/**
 * 凭据相关错误的分类。
 *
 * 每一类都对应页面上或作业结果里一种不同的处理方式，不能合并:
 *
 * - `CredentialKeyError`：服务端没配主密钥。这是部署问题，不是用户填错，提示要指向运维。
 * - `CredentialMissingError`：这个人还没配凭据。要给出去配置页的指引，并且**不发任何外部请求**。
 * - `CredentialVerifyError`：凭据填了但没通过真实验证。原样显示失败原因，不入库。
 * - `CredentialDecryptError`：库里有密文但解不开（换了主密钥、密文被挪到别人名下）。
 * - `CredentialInputError`：账号名或密码为空。保存前的本地校验。
 *
 * 消息里永远不带密码明文：错误会被写进页面、作业结果与服务端日志。
 */

import type { CredentialKindName } from "./kinds";
import { CREDENTIAL_KIND_LABELS, CREDENTIAL_PAGE_PATH } from "./kinds";

export class CredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialError";
  }
}

/** 拿不到「当前操作人」。只可能是调用方式写错（脚本里没传 userId），不是用户操作问题。 */
export class CredentialActorError extends CredentialError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialActorError";
  }
}

/** 服务端没配主密钥，或配了但格式不对。 */
export class CredentialKeyError extends CredentialError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialKeyError";
  }
}

/** 这个人还没配这一类凭据。 */
export class CredentialMissingError extends CredentialError {
  readonly kind: CredentialKindName;

  constructor(kind: CredentialKindName) {
    super(missingCredentialMessage(kind));
    this.name = "CredentialMissingError";
    this.kind = kind;
  }
}

/** 真实登录验证失败。`reason` 就是页面上要显示的那句话。 */
export class CredentialVerifyError extends CredentialError {
  readonly kind: CredentialKindName;
  readonly reason: string;

  constructor(kind: CredentialKindName, reason: string, options?: ErrorOptions) {
    super(`${CREDENTIAL_KIND_LABELS[kind]}验证没通过：${reason}`, options);
    this.name = "CredentialVerifyError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** 密文解不开：主密钥版本对不上、主密钥换了、或密文被挪到了别人名下。 */
export class CredentialDecryptError extends CredentialError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialDecryptError";
  }
}

/** 账号名或密码为空。 */
export class CredentialInputError extends CredentialError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialInputError";
  }
}

/** 未配置时给用户看的那句话：说清楚要配哪一套，并给出去配置页的地址。 */
export function missingCredentialMessage(kind: CredentialKindName): string {
  return `请先在「我的账号」配置 ${CREDENTIAL_KIND_LABELS[kind]}（${CREDENTIAL_PAGE_PATH}）。`;
}
