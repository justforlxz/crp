/**
 * Webhook 事件的唯一定义处。
 *
 * 事件清单只有这六项：提测创建、构建开始、构建完成、构建失败、认领失败、提测状态同步。
 * 页面上的订阅选项、端点保存时的校验、投递正文里的 `type` 字段全部从这里取，
 * 其他地方不得再抄一份清单。
 */

export const WEBHOOK_EVENT_TYPES = [
  "release.created",
  "build.started",
  "build.succeeded",
  "build.failed",
  "build.claim_failed",
  "release.status_synced",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** 事件的中文名，页面与文档显示用。 */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "release.created": "提测创建",
  "build.started": "构建开始",
  "build.succeeded": "构建完成",
  "build.failed": "构建失败",
  "build.claim_failed": "认领失败",
  "release.status_synced": "提测状态同步",
};

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** 清单外的事件直接拒绝，避免端点订阅到永远不会发生的事件。 */
export function assertWebhookEventType(value: string): WebhookEventType {
  if (!isWebhookEventType(value)) {
    throw new Error(
      `未知的 Webhook 事件类型：${value}。可选值：${WEBHOOK_EVENT_TYPES.join("、")}`,
    );
  }

  return value;
}

/** 投递正文的固定结构：事件标识、类型、产生时间与业务数据。 */
export type WebhookEventBody = {
  /** 事件标识。同一次事件投给多个端点、重试多次时都用这一个值，便于外部去重。 */
  id: string;
  type: WebhookEventType;
  /** 事件产生时间，ISO 8601（UTC）。 */
  createdAt: string;
  /** 业务数据，由触发方填写，例如 `releaseId`、`buildTaskId`。 */
  data: Record<string, unknown>;
};

export function createWebhookEventBody(
  type: WebhookEventType,
  data: Record<string, unknown>,
  options: { id?: string; now?: Date } = {},
): WebhookEventBody {
  return {
    id: options.id ?? crypto.randomUUID(),
    type,
    createdAt: (options.now ?? new Date()).toISOString(),
    data,
  };
}

/**
 * 投递日志里的「关联记录」：从事件正文中取提测或构建任务的标识。
 *
 * 只看 `data` 里约定的两个字段，取不到就返回空，不影响投递本身。
 */
export function relatedRecordOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const record = data as Record<string, unknown>;

  for (const key of ["buildTaskId", "releaseId"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return null;
}
