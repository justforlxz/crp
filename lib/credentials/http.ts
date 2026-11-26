/**
 * 凭据相关的错误 → 接口响应。
 *
 * 每种错误对应的处理人不一样，合并成一个 502 会让人做错事：
 *
 * | 错误 | 状态码 / 错误码 | 谁来处理 |
 * | --- | --- | --- |
 * | `CredentialMissingError` | 409 `credential_missing` | 用户本人，消息里带配置页地址 |
 * | `CredentialKeyError` | 503 `credential_key_missing` | 运维（服务端没配主密钥） |
 * | `CredentialDecryptError` | 409 `credential_decrypt_failed` | 用户本人重配一次 |
 * | `CredentialVerifyError` | 422 `credential_verify_failed` | 用户本人（页面会显示原因） |
 * | `CredentialInputError` | 400 `invalid_payload` | 用户本人（填漏了） |
 *
 * 不是凭据问题就返回 `null`，把错误交回调用方原来的映射 —— 这里不吞任何异常。
 */

import { NextResponse } from "next/server";

import { errorJson } from "../auth/http";
import {
  CredentialDecryptError,
  CredentialInputError,
  CredentialKeyError,
  CredentialMissingError,
  CredentialVerifyError,
} from "./errors";

export function credentialErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof CredentialMissingError) {
    return errorJson(409, "credential_missing", error.message);
  }

  if (error instanceof CredentialKeyError) {
    return errorJson(503, "credential_key_missing", error.message);
  }

  if (error instanceof CredentialDecryptError) {
    return errorJson(409, "credential_decrypt_failed", error.message);
  }

  if (error instanceof CredentialVerifyError) {
    return errorJson(422, "credential_verify_failed", error.message);
  }

  if (error instanceof CredentialInputError) {
    return errorJson(400, "invalid_payload", error.message);
  }

  return null;
}
