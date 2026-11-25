/**
 * CRP 客户端的五类错误。
 *
 * 调用方要按类别做不同的事：网络错误可以排队重试，限流只能等，认证错误要重新登录，
 * 业务拒绝要把 CRP 的原话给用户看，参数非法压根不该发请求。所以分类做成五个类，
 * 用 `instanceof` 判断，不靠字符串标签。
 *
 * 每类都带 `responseSnippet`（CRP 原始响应的片段），方便直接把服务器的话显示出来。
 * 片段里不会出现 token 或密码：请求头从不进错误消息。
 */

export type CrpErrorKind = "network" | "rate_limited" | "auth" | "business" | "invalid";

/** 响应片段最多留这么多字符，够看清 CRP 的报错，又不会把整页塞进日志。 */
const SNIPPET_LIMIT = 500;

/** 把响应体裁成可读片段。 */
export function responseSnippet(body: string): string {
  const trimmed = body.trim();

  return trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed;
}

export type CrpErrorOptions = {
  /** HTTP 状态码；本地校验失败时没有。 */
  status?: number;
  /** CRP 原始响应片段。 */
  responseSnippet?: string;
  /**
   * 限流时 CRP 给的等待秒数（来自响应头 `Retry-After`）。
   *
   * 只有 `CrpRateLimitedError` 会填它。放在基类上是因为错误对象从请求层往上抛时类型是
   * `CrpError`，上层不该为了读一个数字再做一次 `instanceof` 之外的字符串解析。
   */
  retryAfterSeconds?: number | null;
  cause?: unknown;
};

/** 所有 CRP 错误的基类。 */
export class CrpError extends Error {
  readonly kind: CrpErrorKind;
  readonly status?: number;
  readonly responseSnippet?: string;
  /** 限流时该等多少秒；没有这个信息（或不是限流）时为 `null`。 */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, kind: CrpErrorKind, options: CrpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CrpError";
    this.kind = kind;
    this.status = options.status;
    this.responseSnippet = options.responseSnippet;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** 连不上、超时、重试用尽仍是 5xx。调用方可以稍后重试。 */
export class CrpNetworkError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "network", options);
    this.name = "CrpNetworkError";
  }
}

/**
 * CRP 在限流（HTTP 429）：请求本身没有错，只是这个窗口里发得太密。
 *
 * 与网络错误分开：网络错误可以排队重试，限流只能等 —— 立刻重发只会延长限流窗口；
 * 而运维看到「网络错误」会去查链路，方向就错了。重发交给调用方的定时器，
 * 请求层一次都不重试（见 `request.ts`）。
 */
export class CrpRateLimitedError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "rate_limited", options);
    this.name = "CrpRateLimitedError";
  }
}

/** 401/403、登录被拒、拿不到 token。换凭据或重新登录才能继续。 */
export class CrpAuthError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "auth", options);
    this.name = "CrpAuthError";
  }
}

/** CRP 明确拒绝了这次请求，并把原因写在响应里。重试同样的请求没有意义。 */
export class CrpBusinessError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "business", options);
    this.name = "CrpBusinessError";
  }
}

/** 请求参数在本地就能判定不合法，请求没有发出去。 */
export class CrpInvalidParameterError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "invalid", options);
    this.name = "CrpInvalidParameterError";
  }
}
