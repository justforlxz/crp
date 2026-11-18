/**
 * 一次投递的执行过程：发送、判成败、按指数退避重试。
 *
 * 这里只有纯逻辑：发送、等待、取时间都从参数注入，所以重试次数与退避间隔能直接断言，
 * 不需要真的等 15 秒，也不需要起 HTTP 服务。写库与读端点由 `service.ts` 负责。
 */

/** 一次投递最多尝试几次（含首次）。 */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** 指数退避的起点，每失败一次翻倍。 */
export const RETRY_BASE_DELAY_MS = 1_000;
/** 退避上限，防止延迟无限增长。 */
export const RETRY_MAX_DELAY_MS = 30_000;
/** 单次请求的超时时间：端点不响应时不能把投递流程挂住。 */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** 响应摘要入库前的截断长度。 */
export const RESPONSE_SNIPPET_LIMIT = 500;

/** 第 `failedAttempts` 次失败之后要等多久：1s、2s、4s、8s。 */
export function retryDelayMs(failedAttempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (failedAttempts - 1), RETRY_MAX_DELAY_MS);
}

/** 投递目标。这里不出现签名密钥：签名由调用方算好，随请求一起传进来。 */
export type DeliveryTarget = {
  name: string;
  url: string;
};

/**
 * 一次投递要发的请求。
 *
 * 正文与签名头都由调用方生成一次：**入库的那份签名与真正发出去的是同一份**，
 * 重试也原样重发，接收方按签名去重即可。
 */
export type SignedRequest = {
  /** 请求体原文。 */
  body: string;
  /** `X-Crp-Timestamp` 与 `X-Crp-Signature`，整次投递（含重试）共用。 */
  headers: Record<string, string>;
};

/**
 * 响应摘要：按字符截断，入库结果不超过 `limit` 个字（含结尾的省略号）。
 *
 * 按字符而不是按字节切，是为了不把 emoji 之类的代理对切成半个。
 */
export function truncateResponseSnippet(
  text: string,
  limit: number = RESPONSE_SNIPPET_LIMIT,
): string {
  // 只切出前 limit * 2 个码元再拆字符：端点返回很大响应时不会整段进内存，
  // 而 limit 个字最多占 limit * 2 个码元，够判断了。
  const head = text.slice(0, limit * 2);
  const characters = Array.from(head);

  // 切片正好覆盖原文，说明原文本来就装得下，原样返回。
  if (characters.length <= limit && head.length === text.length) {
    return text;
  }

  return `${characters.slice(0, limit - 1).join("")}…`;
}

export type WebhookHttpResponse = { status: number; body: string };

export type WebhookRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/** 发一次请求。网络错误直接抛，由投递循环记为该次尝试失败。 */
export type WebhookSender = (request: WebhookRequest) => Promise<WebhookHttpResponse>;

/** 一次投递的最终结果，字段与 `webhook_delivery` 的对应列一一对应。 */
export type DeliveryOutcome = {
  ok: boolean;
  attempts: number;
  httpStatus: number | null;
  durationMs: number;
  responseSnippet: string | null;
  lastError: string | null;
};

export type DeliverOptions = {
  send: WebhookSender;
  /** 等待函数，正式环境是 setTimeout，测试里是收集延迟的假函数。 */
  sleep: (ms: number) => Promise<void>;
  /** 单调递增的毫秒时间源，用来量每次尝试的耗时。 */
  now: () => number;
  /** 重试日志，不传就不打。日志里不得出现密钥。 */
  log: (message: string) => void;
  maxAttempts?: number;
};

/**
 * 发一次投递，失败按指数退避重试，最多 `MAX_DELIVERY_ATTEMPTS` 次。
 *
 * 每次尝试打一行日志，所以 5 次尝试在进程日志里是 5 条记录。
 * 正文与签名头由调用方一次算好传进来，重试原样重发。这个函数不自己算签名，
 * 所以写进投递记录的签名与接收方收到的必然是同一份。
 */
export async function deliverWebhook(
  target: DeliveryTarget,
  request: SignedRequest,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const eventType = eventTypeOf(request.body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...request.headers,
  };

  let attempts = 0;
  let httpStatus: number | null = null;
  let durationMs = 0;
  let responseSnippet: string | null = null;
  let lastError: string | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    const startedAt = options.now();

    try {
      const response = await options.send({
        url: target.url,
        headers,
        body: request.body,
      });
      durationMs = Math.max(0, Math.round(options.now() - startedAt));
      httpStatus = response.status;
      responseSnippet = truncateResponseSnippet(response.body);

      if (response.status >= 200 && response.status < 300) {
        options.log(
          `[webhook] 投递成功 endpoint=${target.name} event=${eventType} 第 ${attempts}/${maxAttempts} 次 http=${response.status} 耗时 ${durationMs}ms`,
        );

        return { ok: true, attempts, httpStatus, durationMs, responseSnippet, lastError: null };
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      durationMs = Math.max(0, Math.round(options.now() - startedAt));
      httpStatus = null;
      responseSnippet = null;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const nextDelay = attempts < maxAttempts ? retryDelayMs(attempts) : null;
    options.log(
      `[webhook] 投递失败 endpoint=${target.name} event=${eventType} 第 ${attempts}/${maxAttempts} 次 http=${httpStatus ?? "-"} 耗时 ${durationMs}ms 原因=${lastError}` +
        (nextDelay === null ? "，已达上限不再重试" : `，${nextDelay}ms 后重试`),
    );

    if (nextDelay === null) {
      break;
    }

    await options.sleep(nextDelay);
  }

  return {
    ok: false,
    attempts,
    httpStatus,
    durationMs,
    responseSnippet,
    lastError,
  };
}

/** 日志里要打事件类型：正文是 JSON 字符串，解析一次即可；解析不出来就写 `-`。 */
function eventTypeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : "-";
  } catch {
    return "-";
  }
}

/** 正式环境用的发送器：Node 内置 fetch，非 2xx 也照常返回，由投递循环判成败。 */
export const fetchSender: WebhookSender = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => "");

  return { status: response.status, body: text };
};

/** 正式环境用的等待函数。 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
