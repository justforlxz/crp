/**
 * `lib/webhook` 的公开出口。
 *
 * 后续节点（A11 创建提测、A12 投递排队、A13 记录详情、A14 构建队列）只需要
 * `emitEvent` 与事件类型，其余都是端点管理与验收用的内部件。
 */

export {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_EVENT_LABELS,
  isWebhookEventType,
  assertWebhookEventType,
  createWebhookEventBody,
  relatedRecordOf,
} from "./events";
export type { WebhookEventType, WebhookEventBody } from "./events";

export {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  computeWebhookSignature,
  verifyWebhookSignature,
} from "./signature";

export {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RESPONSE_SNIPPET_LIMIT,
  retryDelayMs,
  truncateResponseSnippet,
  deliverWebhook,
} from "./deliver";
export type {
  DeliveryOutcome,
  DeliveryTarget,
  SignedRequest,
  WebhookSender,
} from "./deliver";

export {
  emitEvent,
  sendTestEvent,
  listRecentDeliveries,
  waitForWebhookDeliveries,
} from "./service";
export type {
  EmitEventOptions,
  EmitEventResult,
  WebhookDeliveryLogRow,
} from "./service";

export {
  listWebhookEndpoints,
  listWebhookWorkspaces,
  createWebhookEndpoint,
  setWebhookEndpointEnabled,
} from "./endpoints";
export type { WebhookEndpointInput, WebhookEndpointSummary } from "./endpoints";

export {
  WebhookInputError,
  normalizeEventTypes,
  validateEndpointName,
  validateEndpointSecret,
  validateEndpointUrl,
} from "./validation";
