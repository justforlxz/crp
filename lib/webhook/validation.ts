/**
 * 端点保存前的校验。纯函数，不碰数据库，便于直接断言。
 */

import { assertWebhookEventType, type WebhookEventType } from "./events";

/** 输入不合法时抛出，消息直接显示在页面上。 */
export class WebhookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookInputError";
  }
}

export function validateEndpointName(value: string): string {
  const name = value.trim();
  if (name === "") {
    throw new WebhookInputError("端点名称不能为空。");
  }

  if (name.length > 100) {
    throw new WebhookInputError("端点名称最多 100 个字。");
  }

  return name;
}

/** 回调地址必须是完整的 http/https 地址，保存时统一成 URL 规范形式。 */
export function validateEndpointUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new WebhookInputError("回调地址不能为空。");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebhookInputError(`回调地址不是合法的 URL：${trimmed}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebhookInputError("回调地址只支持 http 与 https。");
  }

  return url.toString();
}

/** 签名密钥由使用者自己填写，页面不回显，只用于投递时算签名。 */
export function validateEndpointSecret(value: string): string {
  const secret = value.trim();
  if (secret === "") {
    throw new WebhookInputError("签名密钥不能为空。");
  }

  if (secret.length < 8) {
    throw new WebhookInputError("签名密钥至少 8 个字符。");
  }

  return secret;
}

/** 订阅的事件：去重、去掉空值，并逐个对照事件清单。 */
export function normalizeEventTypes(values: readonly string[]): WebhookEventType[] {
  const unique = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value !== "")),
  ];

  if (unique.length === 0) {
    throw new WebhookInputError("至少订阅一个事件。");
  }

  try {
    return unique.map(assertWebhookEventType);
  } catch (error) {
    // 事件清单的报错文案只维护一处，这里只把类型换成页面能直接展示的那种。
    throw new WebhookInputError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
