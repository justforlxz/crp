/**
 * 请求策略层：超时、重试、错误分类，以及把登录态接进每一次请求。
 *
 * 四条策略：
 *
 * - 30 秒超时，失败重试 3 次，退避 300 / 600 / 1200 毫秒。
 * - 429 是限流，单独归成 `CrpRateLimitedError`，**一次都不重试**：按定义等一个窗口，
 *   立刻重发只会让限流窗口继续延长。等多久由调用方的定时器决定，消息里带上 CRP 给的
 *   `Retry-After`。此前把 429 当网络错误连试三次，实测把限流拖成了四十多分钟。
 * - CRP 明确拒绝的请求（响应里带 `message`）不重试：同一份请求体重试一百次，结果一样。
 * - 401 且有凭据时，只换一次新 token 再重放原请求。
 *
 * 错误消息只带方法、路径、状态码与响应体片段，从不带请求头，所以 token 与密码不会进日志。
 */

import {
  CRP_DEFAULT_BASE_URL,
  CRP_DEFAULT_RETRIES,
  CRP_DEFAULT_TIMEOUT_MS,
} from "./config";
import {
  CrpAuthError,
  CrpBusinessError,
  CrpError,
  CrpNetworkError,
  CrpRateLimitedError,
  responseSnippet,
} from "./errors";
import { parseBody, sendRequest, type CrpRequest, type CrpSendContext } from "./http";
import { readMessage } from "./response";
import { createCrpSession, type CrpSession } from "./session";

/** 可以安全重试的状态码：服务端临时故障。429 是限流，单独处理，见 `toHttpError`。 */
const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504]);

/** 重试等待的基数，毫秒。 */
const BACKOFF_BASE_MS = 300;

/** 一次请求的观察结果。字段与 `crp_call_log` 的列一一对应。 */
export type CrpRequestObservation = {
  /** HTTP 方法。 */
  method: CrpRequest["method"];
  /** 完整地址，含接口前缀与查询串。 */
  url: string;
  /** HTTP 状态码；连不上、超时这类没有响应的情况为空。 */
  statusCode: number | null;
  /** 本次请求的耗时（毫秒）。 */
  durationMs: number;
  /** 响应体摘要（截断 500 字）；没有响应时是失败原因。 */
  responseSnippet: string | null;
};

/** 请求观察者。可以是异步的，请求层会等它结束再继续。 */
export type CrpRequestObserver = (
  observation: CrpRequestObservation,
) => void | Promise<void>;

export type CrpTransportOptions = {
  /** 接口前缀，默认 `https://crp.uniontech.com/api`。 */
  baseUrl?: string;
  /** LDAP 账号；按需登录时必填。 */
  username?: string;
  /** LDAP 密码；按需登录时必填。 */
  password?: string;
  /** 直接给一个 token，跳过登录与缓存读取。 */
  token?: string;
  /**
   * 进程内令牌缓存的键（账号 ID）。
   *
   * 传了就按这个键缓存令牌，同一进程里不同人的令牌互不覆盖；不传就是不缓存，
   * 每次新建客户端都要登录一次。**没有落盘选项**：共用文件会让 A 的令牌被 B 拿去用。
   */
  tokenKey?: string | null;
  /** 单次请求超时，毫秒。 */
  timeoutMs?: number;
  /** 失败重试次数，不含首次请求。 */
  retries?: number;
  /** 注入用，便于测试替换网络层。 */
  fetchImpl?: typeof fetch;
  /** 注入用，便于测试跳过真实等待。 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入用，便于测试伪造当前时间（毫秒）。 */
  now?: () => number;
  /**
   * 每次请求的观察者：给调用方记调用日志用。
   *
   * 每一次真正发出的请求都会回调一次（含重试的每一次、以及登录），
   * 成功、HTTP 失败、连不上三种情况都有回调，其中连不上时 `statusCode` 为 `null`。
   * 观察者抛错只打进程日志，不影响这次请求本身。
   */
  onRequest?: CrpRequestObserver;
};

export type CrpTransport = {
  /** 发一次请求并解析响应；失败按四类错误抛出。 */
  request<T>(init: CrpRequest): Promise<T>;
  /** 登录并返回 token；已有可用缓存时直接用缓存。 */
  login(): Promise<string>;
};

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `Retry-After` → 秒数。
 *
 * 只认「秒」这一种写法（CRP 给的就是秒）。HTTP 规范还允许给一个日期，遇到那种写法返回
 * `null`：宁可不显示等待时间，也不要显示一个编出来的数字。
 */
function parseRetryAfterSeconds(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number.parseInt(value.trim(), 10);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** 把失败响应翻译成五类错误里合适的那一类。 */
function toHttpError(
  init: CrpRequest,
  status: number,
  text: string,
  retries: number,
  retryAfter: string | null,
): CrpError {
  const snippet = responseSnippet(text);
  const label = `${init.method} ${init.path} 失败（HTTP ${status}）`;
  const message = readMessage(text);

  if (status === 401 || status === 403) {
    return new CrpAuthError(`${label}：${message ?? "凭据被拒绝或没有权限"}`, {
      status,
      responseSnippet: snippet,
    });
  }

  // 限流要先于「响应带 message」判定：429 的响应体可能也带 message，
  // 那种情况仍然是限流，不是 CRP 拒绝了这份请求。
  if (status === 429) {
    const wait = retryAfter === null ? "" : `（Retry-After: ${retryAfter}）`;

    return new CrpRateLimitedError(`${label}：CRP 限流，请稍后重试${wait}`, {
      status,
      responseSnippet: snippet,
      retryAfterSeconds: parseRetryAfterSeconds(retryAfter),
    });
  }

  if (message) {
    return new CrpBusinessError(`${label}：${message}`, { status, responseSnippet: snippet });
  }

  if (RETRYABLE_STATUS.has(status)) {
    return new CrpNetworkError(`${label}：CRP 服务端异常，重试 ${retries} 次后仍失败`, {
      status,
      responseSnippet: snippet,
    });
  }

  return new CrpBusinessError(`${label}：CRP 拒绝了这次请求`, {
    status,
    responseSnippet: snippet,
  });
}

/** CRP 有些接口用 200 + `{status: "error"}` 表达失败，不能只看状态码。 */
function assertSuccessEnvelope(init: CrpRequest, parsed: unknown): void {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }

  const envelope = parsed as { status?: unknown; message?: unknown };
  if (typeof envelope.status !== "string" || envelope.status === "success") {
    return;
  }

  const detail =
    typeof envelope.message === "string" && envelope.message.trim() !== ""
      ? envelope.message
      : JSON.stringify(envelope).slice(0, 300);

  throw new CrpBusinessError(`${init.method} ${init.path} 被 CRP 拒绝：${detail}`, {
    responseSnippet: responseSnippet(JSON.stringify(parsed)),
  });
}

export function createCrpTransport(options: CrpTransportOptions = {}): CrpTransport {
  const baseUrl = (options.baseUrl ?? CRP_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? CRP_DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? CRP_DEFAULT_RETRIES;
  const sleep = options.sleepImpl ?? sleepDefault;
  const sendContext: CrpSendContext = {
    baseUrl,
    timeoutMs,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const now = options.now ?? Date.now;

  /** 记一次请求。观察者自己出问题时只打进程日志，不影响这次调用。 */
  async function observe(record: CrpRequestObservation): Promise<void> {
    if (options.onRequest === undefined) {
      return;
    }

    try {
      await options.onRequest(record);
    } catch (error) {
      console.error(`[crp] 记录 ${record.method} ${record.url} 的调用失败：`, error);
    }
  }

  const session: CrpSession = createCrpSession({
    username: options.username,
    password: options.password,
    token: options.token,
    tokenKey: options.tokenKey ?? null,
    now,
    postLogin: (body) =>
      request<{ Token?: unknown }>({
        method: "POST",
        path: "/login",
        body,
        auth: false,
        expectedStatus: [200, 201],
      }),
  });

  /** 按状态码与响应内容决定这次失败要不要再试。 */
  function shouldRetry(status: number, text: string, attempt: number): boolean {
    if (attempt >= retries || !RETRYABLE_STATUS.has(status)) {
      return false;
    }

    // 带 message 的响应是 CRP 的明确拒绝，重试同样的请求没有意义。
    return readMessage(text) === null;
  }

  async function request<T>(init: CrpRequest): Promise<T> {
    const expected = init.expectedStatus ?? [200];
    const useAuth = init.auth !== false;
    let attempt = 0;
    let relogged = false;

    for (;;) {
      const token = useAuth ? await session.authorize() : null;
      const startedAt = now();

      let outcome: { status: number; text: string; retryAfter: string | null };
      try {
        outcome = await sendRequest(init, token, sendContext);
      } catch (error) {
        // 连不上也算一次调用：没有状态码，把失败原因当响应摘要记下来。
        await observe({
          method: init.method,
          url: `${baseUrl}${init.path}`,
          statusCode: null,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          responseSnippet: error instanceof Error ? error.message : String(error),
        });

        if (error instanceof CrpNetworkError && attempt < retries) {
          attempt += 1;
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          continue;
        }

        throw error;
      }

      await observe({
        method: init.method,
        url: `${baseUrl}${init.path}`,
        statusCode: outcome.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        responseSnippet: responseSnippet(outcome.text),
      });

      // token 过期时 CRP 回 401：有凭据就换一次新 token，只换一次。
      if (outcome.status === 401 && useAuth && !relogged && session.canLogin()) {
        relogged = true;
        session.reset();
        await session.login();
        continue;
      }

      if (expected.includes(outcome.status)) {
        const parsed = parseBody(outcome.text);
        assertSuccessEnvelope(init, parsed);
        return parsed as T;
      }

      if (shouldRetry(outcome.status, outcome.text, attempt)) {
        attempt += 1;
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      throw toHttpError(
        init,
        outcome.status,
        outcome.text,
        retries,
        outcome.retryAfter,
      );
    }
  }

  return { request, login: () => session.login() };
}
