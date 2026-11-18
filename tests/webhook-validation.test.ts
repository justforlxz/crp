import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEventTypes,
  validateEndpointName,
  validateEndpointSecret,
  validateEndpointUrl,
  WebhookInputError,
} from "../lib/webhook/validation";

test("端点名称去掉首尾空白，空名与超长名被拒绝", () => {
  assert.equal(validateEndpointName("  桌面核心组  "), "桌面核心组");
  assert.throws(() => validateEndpointName("   "), WebhookInputError);
  assert.throws(() => validateEndpointName("件".repeat(101)), WebhookInputError);
  assert.equal(validateEndpointName("件".repeat(100)).length, 100);
});

test("回调地址只收 http 与 https，其它一律拒绝", () => {
  assert.equal(validateEndpointUrl(" https://example.com/crp "), "https://example.com/crp");
  assert.equal(validateEndpointUrl("http://127.0.0.1:8080/hook"), "http://127.0.0.1:8080/hook");

  for (const url of ["", "example.com/crp", "ftp://example.com/crp", "javascript:alert(1)"]) {
    assert.throws(() => validateEndpointUrl(url), WebhookInputError, `${url} 应该被拒绝`);
  }
});

test("签名密钥必须有内容且不短于 8 个字符", () => {
  assert.equal(validateEndpointSecret("  s3cret-key  "), "s3cret-key");
  assert.throws(() => validateEndpointSecret("   "), WebhookInputError);
  assert.throws(() => validateEndpointSecret("short"), WebhookInputError);
});

test("订阅事件去重、去空白，并且必须落在事件清单里", () => {
  assert.deepEqual(
    normalizeEventTypes([" build.failed ", "build.failed", "release.created"]),
    ["build.failed", "release.created"],
  );

  assert.throws(() => normalizeEventTypes([]), WebhookInputError);
  assert.throws(() => normalizeEventTypes(["  "]), WebhookInputError);

  // 清单外的类型（例如上一版种子数据里的 release.success）被拒绝，并列出可选值。
  assert.throws(
    () => normalizeEventTypes(["release.success"]),
    (error: unknown) =>
      error instanceof WebhookInputError &&
      error.message.includes("release.success") &&
      error.message.includes("release.created"),
  );
});
