import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWebhookEventType,
  createWebhookEventBody,
  isWebhookEventType,
  relatedRecordOf,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "../lib/webhook/events";

test("事件清单固定六项，顺序与中文名固定", () => {
  assert.deepEqual([...WEBHOOK_EVENT_TYPES], [
    "release.created",
    "build.started",
    "build.succeeded",
    "build.failed",
    "build.claim_failed",
    "release.status_synced",
  ]);

  assert.deepEqual(
    WEBHOOK_EVENT_TYPES.map((type) => WEBHOOK_EVENT_LABELS[type]),
    ["提测创建", "构建开始", "构建完成", "构建失败", "认领失败", "提测状态同步"],
  );

  // 清单是唯一来源：每个类型都有中文名，且没有重复项。
  assert.equal(new Set(WEBHOOK_EVENT_TYPES).size, WEBHOOK_EVENT_TYPES.length);
  assert.deepEqual(Object.keys(WEBHOOK_EVENT_LABELS).sort(), [...WEBHOOK_EVENT_TYPES].sort());
});

test("清单外的事件既不被识别，也不能通过断言", () => {
  assert.equal(isWebhookEventType("release.success"), false);
  assert.equal(isWebhookEventType("build.failed"), true);

  assert.throws(
    () => assertWebhookEventType("release.success"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("release.success") &&
      error.message.includes("release.created"),
  );
});

test("投递正文结构固定：事件标识、类型、产生时间、业务数据", () => {
  const body = createWebhookEventBody(
    "build.failed",
    { releaseId: "release-1", buildTaskId: "build-1", reason: "上游失败" },
    { id: "evt-1", now: new Date("2026-11-18T20:00:00.000Z") },
  );

  assert.deepEqual(body, {
    id: "evt-1",
    type: "build.failed",
    createdAt: "2026-11-18T20:00:00.000Z",
    data: { releaseId: "release-1", buildTaskId: "build-1", reason: "上游失败" },
  });
});

test("不给事件标识时自动生成，两次不同", () => {
  const first = createWebhookEventBody("release.created", {});
  const second = createWebhookEventBody("release.created", {});

  assert.notEqual(first.id, second.id);
  assert.ok(first.id.length > 0);
});

test("关联记录优先取构建任务，其次取提测，取不到返回空", () => {
  assert.equal(relatedRecordOf({ buildTaskId: "build-1", releaseId: "release-1" }), "build-1");
  assert.equal(relatedRecordOf({ releaseId: "release-1" }), "release-1");
  assert.equal(relatedRecordOf({ releaseId: "   " }), null);
  assert.equal(relatedRecordOf({}), null);
  assert.equal(relatedRecordOf(null), null);
  assert.equal(relatedRecordOf("release-1"), null);
});

test("全部五种事件都能构造出合法正文", () => {
  for (const type of WEBHOOK_EVENT_TYPES as readonly WebhookEventType[]) {
    const body = createWebhookEventBody(type, { releaseId: "release-1" });
    assert.equal(body.type, type);
    assert.equal(typeof body.createdAt, "string");
    assert.equal(Number.isNaN(Date.parse(body.createdAt)), false);
  }
});
