/**
 * Webhook 端点的读写。
 *
 * 密钥只在这里进库：列表查询不投影 `secret`，页面与日志都拿不到明文。
 */

import { prisma } from "../db";
import { normalizeEventTypes, validateEndpointName, validateEndpointSecret, validateEndpointUrl, WebhookInputError } from "./validation";

export type WebhookEndpointInput = {
  workspaceId: string;
  name: string;
  url: string;
  eventTypes: readonly string[];
  secret: string;
  description?: string | null;
  enabled?: boolean;
};

/** 页面列表用的端点信息，刻意不含 `secret`。 */
export type WebhookEndpointSummary = {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  description: string | null;
  createdAt: Date;
};

const SUMMARY_FIELDS = {
  id: true,
  name: true,
  url: true,
  eventTypes: true,
  enabled: true,
  description: true,
  createdAt: true,
} as const;

export async function listWebhookEndpoints(
  workspaceId: string,
): Promise<WebhookEndpointSummary[]> {
  return prisma.webhookEndpoint.findMany({
    where: { workspaceId },
    select: SUMMARY_FIELDS,
    orderBy: { createdAt: "asc" },
  });
}

/** 新建端点。`(workspaceId, url)` 已存在时给出可读的提示，而不是抛数据库错误。 */
export async function createWebhookEndpoint(
  input: WebhookEndpointInput,
): Promise<WebhookEndpointSummary> {
  const name = validateEndpointName(input.name);
  const url = validateEndpointUrl(input.url);
  const secret = validateEndpointSecret(input.secret);
  const eventTypes = normalizeEventTypes(input.eventTypes);

  const existing = await prisma.webhookEndpoint.findUnique({
    where: { workspaceId_url: { workspaceId: input.workspaceId, url } },
    select: { id: true },
  });

  if (existing) {
    throw new WebhookInputError(`这个工作区已经登记过回调地址 ${url}。`);
  }

  return prisma.webhookEndpoint.create({
    data: {
      workspaceId: input.workspaceId,
      name,
      url,
      secret,
      eventTypes,
      enabled: input.enabled ?? true,
      description: input.description?.trim() || null,
    },
    select: SUMMARY_FIELDS,
  });
}

export async function setWebhookEndpointEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await prisma.webhookEndpoint.update({ where: { id }, data: { enabled } });
}
