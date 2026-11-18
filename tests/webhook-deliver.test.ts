import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverWebhook,
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  RESPONSE_SNIPPET_LIMIT,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  truncateResponseSnippet,
  type DeliveryTarget,
  type SignedRequest,
  type WebhookRequest,
} from "../lib/webhook/deliver";
import {
  computeWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../lib/webhook/signature";

const TARGET: DeliveryTarget = {
  name: "接收端点",
  url: "https://hooks.example.com/crp",
};

const BODY = '{"id":"evt-1","type":"build.failed","createdAt":"2026-11-18T20:00:00.000Z","data":{}}';
const TIMESTAMP = "1763496000";

/** 签名头由调用方一次算好传进来，投递只管原样发出。 */
const REQUEST: SignedRequest = {
  body: BODY,
  headers: {
    [WEBHOOK_TIMESTAMP_HEADER]: TIMESTAMP,
    [WEBHOOK_SIGNATURE_HEADER]: computeWebhookSignature("test-delivery-key", TIMESTAMP, BODY),
  },
};

type Step = { status?: number; body?: string; durationMs?: number; error?: Error };

/** 造一个假时钟：只有假发送器会推进它，所以耗时断言是确定的。 */
function createHarness(script: Step[]) {
  let current = 0;
  const sleeps: number[] = [];
  const requests: WebhookRequest[] = [];
  const logs: string[] = [];

  return {
    sleeps,
    requests,
    logs,
    deps: {
      send: async (request: WebhookRequest) => {
        const step = script.shift();

        if (step === undefined) {
          throw new Error("假发送器的脚本用完了，说明多发了一次请求");
        }

        requests.push(request);

        if (step.error !== undefined) {
          current += step.durationMs ?? 1;
          throw step.error;
        }

        current += step.durationMs ?? 5;

        return { status: step.status ?? 200, body: step.body ?? "" };
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => current,
      log: (message: string) => {
        logs.push(message);
      },
    },
  };
}

test("退避间隔按指数增长：1s、2s、4s、8s，并且有上限", () => {
  assert.equal(RETRY_BASE_DELAY_MS, 1_000);
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(retryDelayMs(10), RETRY_MAX_DELAY_MS);
});

test("首次就成功：只发一次、不等待、状态为成功", async () => {
  const harness = createHarness([{ status: 200, body: '{"ok":true}', durationMs: 12 }]);
  const outcome = await deliverWebhook(TARGET, REQUEST, harness.deps);

  assert.deepEqual(
    { ok: outcome.ok, attempts: outcome.attempts, httpStatus: outcome.httpStatus, lastError: outcome.lastError },
    { ok: true, attempts: 1, httpStatus: 200, lastError: null },
  );
  assert.equal(outcome.durationMs, 12);
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.logs.length, 1);
});

test("连续 500：正好尝试 5 次，4 次退避，最终判失败", async () => {
  const harness = createHarness(
    Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => ({ status: 500, body: "内部错误" })),
  );
  const outcome = await deliverWebhook(TARGET, REQUEST, harness.deps);

  assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 5);
  assert.equal(outcome.httpStatus, 500);
  assert.equal(outcome.lastError, "HTTP 500");
  assert.equal(harness.requests.length, 5);
  assert.deepEqual(harness.sleeps, [1_000, 2_000, 4_000, 8_000]);
});

test("每次尝试打一行日志：5 次失败在进程日志里就是 5 条记录", async () => {
  const harness = createHarness(
    Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => ({ status: 500, body: "内部错误" })),
  );
  await deliverWebhook(TARGET, REQUEST, harness.deps);

  assert.equal(harness.logs.length, 5);
  assert.match(harness.logs[0] as string, /第 1\/5 次/);
  assert.match(harness.logs[4] as string, /第 5\/5 次/);
  assert.match(harness.logs[4] as string, /已达上限不再重试/);
});

test("中途成功就停下：第 3 次成功只等两次退避", async () => {
  const harness = createHarness([
    { status: 503 },
    { status: 500 },
    { status: 200, body: "ok" },
  ]);
  const outcome = await deliverWebhook(TARGET, REQUEST, harness.deps);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(harness.sleeps, [1_000, 2_000]);
});

test("网络错误也按失败重试，最终没有 HTTP 状态码", async () => {
  const harness = createHarness(
    Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => ({
      error: new Error("connect ECONNREFUSED"),
    })),
  );
  const outcome = await deliverWebhook(TARGET, REQUEST, harness.deps);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 5);
  assert.equal(outcome.httpStatus, null);
  assert.equal(outcome.lastError, "connect ECONNREFUSED");
});

test("原样发调用方给的正文与签名头：不自己算签名，重试也不换时间戳", async () => {
  // 每次尝试让假时钟走 2 秒，跨过整秒边界：如果这里重算签名，时间戳与签名就会变。
  const harness = createHarness([
    { status: 500, durationMs: 2_000 },
    { status: 500, durationMs: 2_000 },
    { status: 200, durationMs: 2_000 },
  ]);
  await deliverWebhook(TARGET, REQUEST, harness.deps);

  const [first, second, third] = harness.requests;

  for (const request of harness.requests) {
    assert.equal(request.body, BODY);
    assert.equal(request.headers[WEBHOOK_TIMESTAMP_HEADER], TIMESTAMP);
    assert.equal(
      request.headers[WEBHOOK_SIGNATURE_HEADER],
      REQUEST.headers[WEBHOOK_SIGNATURE_HEADER],
    );
    assert.equal(request.headers["Content-Type"], "application/json; charset=utf-8");
  }

  assert.deepEqual(second?.headers, first?.headers);
  assert.deepEqual(third?.headers, first?.headers);
});

test("响应摘要入库前截断到 500 字，短的保持原样", async () => {
  assert.equal(RESPONSE_SNIPPET_LIMIT, 500);
  assert.equal(truncateResponseSnippet("ok"), "ok");
  assert.equal(truncateResponseSnippet("a".repeat(500)), "a".repeat(500));

  const truncated = truncateResponseSnippet("b".repeat(900));
  assert.equal(Array.from(truncated).length, 500);
  assert.ok(truncated.endsWith("…"));

  // 代理对不切开：801 个字符截成 499 个字符加一个省略号。
  const emoji = truncateResponseSnippet("🙂".repeat(801));
  assert.equal(Array.from(emoji).length, 500);
  assert.equal(emoji.endsWith("…"), true);
  assert.equal(emoji.slice(0, -1), "🙂".repeat(499));
  // 正好 500 个 emoji（1000 个码元）本来就装得下，原样返回、不加省略号。
  assert.equal(truncateResponseSnippet("🙂".repeat(500)), "🙂".repeat(500));

  const harness = createHarness([{ status: 500, body: "c".repeat(800) }]);
  const outcome = await deliverWebhook(TARGET, REQUEST, { ...harness.deps, maxAttempts: 1 });
  assert.equal(Array.from(outcome.responseSnippet ?? "").length, 500);
});
