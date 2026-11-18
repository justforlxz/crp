import assert from "node:assert/strict";
import test from "node:test";

import {
  computeWebhookSignature,
  createWebhookSignatureHeaders,
  signatureMessage,
  signatureTimestamp,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../lib/webhook/signature";

const KEY = "test-hmac-key";
const TIMESTAMP = "1763496000";
const BODY =
  '{"id":"0b9d3e2a-0000-4000-8000-000000000000","type":"release.created","createdAt":"2026-11-18T20:00:00.000Z","data":{"releaseId":"verify-release-882"}}';

/** 固定向量：算法、待签串拼法、编码方式任何一项变了，这里都会挂。 */
const GOLDEN_SIGNATURE =
  "sha256=db3cce182779dbe8625b5bbe562c169a711bf6f8739fd7e43a69b82253833de2";

test("签名的固定向量：HMAC-SHA256(密钥, `<时间戳>.<请求体原文>`)，十六进制加 sha256= 前缀", () => {
  assert.equal(signatureMessage(TIMESTAMP, BODY), `${TIMESTAMP}.${BODY}`);
  assert.equal(computeWebhookSignature(KEY, TIMESTAMP, BODY), GOLDEN_SIGNATURE);
  assert.ok(computeWebhookSignature(KEY, TIMESTAMP, BODY).startsWith(WEBHOOK_SIGNATURE_PREFIX));
});

test("同一份正文与时间戳算出的签名稳定，换了任何一项都不再一致", () => {
  assert.ok(verifyWebhookSignature({ secret: KEY, timestamp: TIMESTAMP, body: BODY, signature: GOLDEN_SIGNATURE }));

  const tampered = [
    { body: `${BODY} `, timestamp: TIMESTAMP, secret: KEY },
    { body: BODY, timestamp: "1763496001", secret: KEY },
    { body: BODY, timestamp: TIMESTAMP, secret: "another-key" },
  ];

  for (const item of tampered) {
    assert.equal(
      verifyWebhookSignature({ ...item, signature: GOLDEN_SIGNATURE }),
      false,
      `改动后不应通过：${JSON.stringify(item)}`,
    );
  }
});

test("签名格式不对时返回 false，而不是抛错", () => {
  for (const signature of ["", "sha256=", "sha1=abc", GOLDEN_SIGNATURE.slice(0, 20)]) {
    assert.equal(verifyWebhookSignature({ secret: KEY, timestamp: TIMESTAMP, body: BODY, signature }), false);
  }
});

test("两个请求头：时间戳是 Unix 秒，签名与按公开算法算出的结果一致", () => {
  const now = new Date("2026-11-18T20:00:00.000Z");
  const { timestamp, headers } = createWebhookSignatureHeaders(KEY, BODY, now);

  assert.equal(timestamp, String(Math.floor(now.getTime() / 1000)));
  assert.equal(headers[WEBHOOK_TIMESTAMP_HEADER], timestamp);
  assert.equal(headers[WEBHOOK_SIGNATURE_HEADER], computeWebhookSignature(KEY, timestamp, BODY));
  assert.equal(signatureTimestamp(now), timestamp);
});

test("签名头里只有时间戳与摘要，不出现密钥", () => {
  const { timestamp, headers } = createWebhookSignatureHeaders(KEY, BODY, new Date("2026-11-18T20:00:00.000Z"));
  const serialized = `${timestamp}${JSON.stringify(headers)}`;

  assert.equal(serialized.includes(KEY), false);
});
