/**
 * CRP 客户端的四类错误。
 *
 * 调用方要按类别做不同的事：网络错误可以排队重试，认证错误要重新登录，
 * 业务拒绝要把 CRP 的原话给用户看，参数非法压根不该发请求。所以分类做成四个类，
 * 用 `instanceof` 判断，不靠字符串标签。
 *
 * 每类都带 `responseSnippet`（CRP 原始响应的片段），方便直接把服务器的话显示出来。
 * 片段里不会出现 token 或密码：请求头从不进错误消息。
 */

export type CrpErrorKind = "network" | "auth" | "business" | "invalid";

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
  cause?: unknown;
};

/** 所有 CRP 错误的基类。 */
export class CrpError extends Error {
  readonly kind: CrpErrorKind;
  readonly status?: number;
  readonly responseSnippet?: string;

  constructor(message: string, kind: CrpErrorKind, options: CrpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CrpError";
    this.kind = kind;
    this.status = options.status;
    this.responseSnippet = options.responseSnippet;
  }
}

/** 连不上、超时、重试用尽仍是 5xx。调用方可以稍后重试。 */
export class CrpNetworkError extends CrpError {
  constructor(message: string, options: CrpErrorOptions = {}) {
    super(message, "network", options);
    this.name = "CrpNetworkError";
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
