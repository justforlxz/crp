/**
 * 事件的记录与投递：`emitEvent` 是 A11–A14 唯一需要调用的入口。
 *
 * 调用方只需要给事件类型与业务数据，剩下的由这里做完：
 * 选出启用的、订阅了该事件的端点 → 每个端点写一条投递记录 → 在后台投递。
 *
 * 「不阻塞主流程」的落点就在这里：`emitEvent` 只等写记录，不等投递；
 * 投递失败只写投递记录与进程日志，不抛给调用方，提测状态不会被它拖垮。
 */

import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../db";
import {
  deliverWebhook,
  fetchSender,
  sleep,
  type DeliveryTarget,
  type SignedRequest,
} from "./deliver";
import {
  createWebhookEventBody,
  relatedRecordOf,
  type WebhookEventType,
} from "./events";
import {
  createWebhookSignatureHeaders,
  WEBHOOK_SIGNATURE_HEADER,
} from "./signature";

/** 正在后台跑的投递任务。 */
const inFlight = new Set<Promise<void>>();

/**
 * 等后台投递全部结束。
 *
 * 只有验收脚本与测试会用到；业务代码不需要它，投递本来就是不等结果的。
 */
export async function waitForWebhookDeliveries(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

export type EmitEventOptions = {
  /** 只投这个工作区的端点；不传则投全部工作区的端点。 */
  workspaceId?: string;
  /** 只投这一个端点，端点管理页的「发送测试事件」用。 */
  endpointId?: string;
};

export type EmitEventResult = {
  eventId: string;
  /** 本次写下的投递记录；没有匹配的端点时为空数组。 */
  deliveryIds: string[];
};

/**
 * 产生一个事件并投递给所有订阅它的端点。
 *
 * 事件类型是编译期的封闭集合：清单外的值在 TypeScript 里过不了，运行时不再重复校验，
 * 真的传进来也只会匹配不到端点、静默不投递。
 *
 * 记录与投递过程中的失败只记日志，不抛给调用方；失败前已经写下的投递记录照常在后台投递。
 */
export async function emitEvent(
  type: WebhookEventType,
  payload: Record<string, unknown>,
  options: EmitEventOptions = {},
): Promise<EmitEventResult> {
  const body = createWebhookEventBody(type, payload);
  const bodyText = JSON.stringify(body);
  const deliveryIds: string[] = [];

  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        // 「哪些端点收这个事件」只在这里判断一次：启用的、且订阅了该事件。
        enabled: true,
        eventTypes: { has: type },
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        ...(options.endpointId === undefined ? {} : { id: options.endpointId }),
      },
    });

    for (const endpoint of endpoints) {
      // 签名只算这一次：写进投递记录的就是随后发出去的那一份，重试也原样重发。
      const { headers } = createWebhookSignatureHeaders(endpoint.secret, bodyText);

      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventType: type,
          payload: body as Prisma.InputJsonValue,
          signature: headers[WEBHOOK_SIGNATURE_HEADER],
          status: "pending",
        },
        select: { id: true },
      });

      deliveryIds.push(delivery.id);
      track({
        deliveryId: delivery.id,
        // 只传投递要用的两项，密钥不留在后台任务里。
        endpoint: { name: endpoint.name, url: endpoint.url },
        request: { body: bodyText, headers },
      });
    }
  } catch (error) {
    // 通知是旁路：它出问题不能影响提测本身的处理结果。
    console.error(`[webhook] 事件 ${type} 的投递准备失败：`, error);
  }

  return { eventId: body.id, deliveryIds };
}

/**
 * 端点管理页的「发送测试事件」：只投给这一个端点。
 *
 * 用真实的事件类型（提测创建）发一条，`data.test` 标明是测试，接收方能一眼认出来。
 */
export async function sendTestEvent(endpointId: string): Promise<EmitEventResult> {
  return emitEvent(
    "release.created",
    { test: true, message: "这是端点管理页发出的测试投递，不是真实提测。" },
    { endpointId },
  );
}

/** 投递日志的一行，页面直接渲染。 */
export type WebhookDeliveryLogRow = {
  id: string;
  createdAt: Date;
  endpointName: string;
  eventType: string;
  relatedRecord: string | null;
  status: string;
  attempts: number;
  httpStatus: number | null;
  durationMs: number | null;
  responseSnippet: string | null;
  lastError: string | null;
};

export async function listRecentDeliveries(
  workspaceId: string,
  limit = 20,
): Promise<WebhookDeliveryLogRow[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { endpoint: { workspaceId } },
    select: {
      id: true,
      createdAt: true,
      eventType: true,
      status: true,
      attempts: true,
      httpStatus: true,
      durationMs: true,
      responseSnippet: true,
      lastError: true,
      payload: true,
      endpoint: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    endpointName: row.endpoint.name,
    eventType: row.eventType,
    relatedRecord: relatedRecordOfPayload(row.payload),
    status: row.status,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    responseSnippet: row.responseSnippet,
    lastError: row.lastError,
  }));
}

/** 一次后台投递：投递记录标识、目标端点、已经算好的正文与签名头。 */
type DeliveryPlan = {
  deliveryId: string;
  endpoint: DeliveryTarget;
  request: SignedRequest;
};

/** 记录一次后台投递，并把结果写回投递记录。 */
function track(plan: DeliveryPlan): void {
  const task = runDelivery(plan)
    .catch((error: unknown) => {
      console.error(`[webhook] 投递记录 ${plan.deliveryId} 执行失败：`, error);
    })
    .finally(() => {
      inFlight.delete(task);
    });

  inFlight.add(task);
}

async function runDelivery(plan: DeliveryPlan): Promise<void> {
  const outcome = await deliverWebhook(plan.endpoint, plan.request, {
    send: fetchSender,
    sleep,
    now: () => Date.now(),
    log: (message) => console.log(message),
  });

  await prisma.webhookDelivery.update({
    where: { id: plan.deliveryId },
    data: {
      status: outcome.ok ? "success" : "failed",
      attempts: outcome.attempts,
      httpStatus: outcome.httpStatus,
      durationMs: outcome.durationMs,
      responseSnippet: outcome.responseSnippet,
      lastError: outcome.lastError,
      deliveredAt: outcome.ok ? new Date() : null,
    },
  });
}

/** 投递正文是 jsonb，取字段前先收窄成对象。 */
function relatedRecordOfPayload(payload: Prisma.JsonValue): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const data = (payload as Record<string, unknown>)["data"];

  return relatedRecordOf(data);
}

