/**
 * 投递签名：`X-Crp-Timestamp` 与 `X-Crp-Signature`。
 *
 * 算法（对外公开，外部接收方按同一算法复算即可验证）：
 *
 *   待签字符串 = `${X-Crp-Timestamp 的原值}.${请求体原文}`
 *   X-Crp-Signature = "sha256=" + hex(HMAC-SHA256(key = 端点密钥, 待签字符串))
 *
 * 时间戳是 Unix 秒，与请求头里的值完全一致；请求体必须是实际发出的字节，
 * 重新序列化后再算会不一致。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TIMESTAMP_HEADER = "X-Crp-Timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "X-Crp-Signature";
export const WEBHOOK_SIGNATURE_PREFIX = "sha256=";

/** 待签字符串：`<时间戳>.<请求体原文>`。 */
export function signatureMessage(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** 请求头里的时间戳：Unix 秒。 */
export function signatureTimestamp(now: Date): string {
  return Math.floor(now.getTime() / 1000).toString();
}

export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(signatureMessage(timestamp, body), "utf8")
    .digest("hex");

  return `${WEBHOOK_SIGNATURE_PREFIX}${digest}`;
}

/** 校验签名，比较过程用定长比较，避免按字节提前返回泄露信息。 */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
}): boolean {
  const expected = computeWebhookSignature(input.secret, input.timestamp, input.body);
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(input.signature, "utf8");

  // 长度不同时 timingSafeEqual 会抛错，先挡掉。
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

/**
 * 一次投递要带的两个签名头。
 *
 * 同一次投递的多次重试用同一组头和同一份正文重发，外部按签名去重即可。
 */
export function createWebhookSignatureHeaders(
  secret: string,
  body: string,
  now: Date = new Date(),
): { timestamp: string; headers: Record<string, string> } {
  const timestamp = signatureTimestamp(now);

  return {
    timestamp,
    headers: {
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: computeWebhookSignature(secret, timestamp, body),
    },
  };
}
