/**
 * 最底层的 HTTP 收发：拼 URL、带 token、解析响应体。
 *
 * 这里不判断重试、不分类错误，只负责“把请求发出去、把响应原样拿回来”，
 * 出问题一律抛 `CrpNetworkError`。重试与错误分类在上层 `request.ts`。
 */

import { CrpNetworkError } from "./errors";

export type CrpRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** 默认 true；只有登录和基线列表不需要。 */
  auth?: boolean;
  expectedStatus?: readonly number[];
};

export type CrpSendContext = {
  /** 接口前缀，不带结尾斜杠。 */
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
};

/** 把响应文本解析成 JSON；不是 JSON 就把原文返回。 */
export function parseBody(text: string): unknown {
  if (text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") {
      return `${timeoutMs} 毫秒内没有响应，已超时`;
    }

    return cause.message;
  }

  return String(cause);
}

/** 发一次请求。连不上、超时、读不出响应体都算网络错误。 */
export async function sendRequest(
  init: CrpRequest,
  token: string | null,
  context: CrpSendContext,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await context.fetchImpl(`${context.baseUrl}${init.path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(context.timeoutMs),
    });
  } catch (cause) {
    throw new CrpNetworkError(
      `${init.method} ${init.path} 请求失败：${describeFailure(cause, context.timeoutMs)}`,
      { cause },
    );
  }

  try {
    return { status: response.status, text: await response.text() };
  } catch (cause) {
    throw new CrpNetworkError(
      `${init.method} ${init.path} 读取响应失败：${describeFailure(cause, context.timeoutMs)}`,
      { cause, status: response.status },
    );
  }
}
