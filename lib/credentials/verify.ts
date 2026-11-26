/**
 * 「保存并验证」的真实验证。
 *
 * 契约要求保存前必须真登录一次，验证失败不入库（`.agents/spec/product/credentials.md`
 * 第八节与 CRED-3）。这里就是那一次真实请求：
 *
 * - CRP：`POST /login`，密码按 CRP 的规矩用它的公钥加密后传（与正常投递走同一套登录）。
 * - Gerrit：`GET /a/projects/` 带 Basic 认证。匿名访问会被 302 到登录页，所以 2xx 才说明
 *   这份 HTTP 凭据被接受。
 *
 * 两个函数都接受注入的 `fetch`，单测不会真的联网。失败原因原样返回给页面，
 * 但只包含状态码与响应体里 CRP / Gerrit 自己给的那句话，不含密码。
 */

import { encryptPassword } from "../integrations/crp/auth";
import { readMessage } from "../integrations/crp/response";
import { readBaseUrl } from "../integrations/endpoints";
import { CredentialVerifyError } from "./errors";
import type { CredentialKindName } from "./kinds";

/** 验证请求的超时：比正常请求短，用户正在页面上等结果。 */
const VERIFY_TIMEOUT_MS = 20_000;

export type VerifyOptions = {
  /** 注入用；生产代码不传。 */
  fetchImpl?: typeof fetch;
  /** 注入用；生产代码不传，按 `CRP_BASE_URL` / `GERRIT_BASE_URL` 取。 */
  baseUrl?: string;
};

/** 按种类验证一份凭据；通过则正常返回，不通过抛 `CredentialVerifyError`。 */
export async function verifyCredential(
  kind: CredentialKindName,
  username: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<void> {
  if (kind === "crp") {
    await verifyCrpLogin(username, secret, options);
    return;
  }

  await verifyGerritLogin(username, secret, options);
}

/** CRP 的真实登录。成功条件是响应里带一个非空的 `Token`。 */
export async function verifyCrpLogin(
  username: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<void> {
  const baseUrl = options.baseUrl ?? readBaseUrl("crp");
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;

  try {
    response = await fetchImpl(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: username,
        password: encryptPassword(secret),
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CredentialVerifyError("crp", `连不上 CRP：${causeMessage(error)}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  const text = await response.text();

  if (!response.ok) {
    throw new CredentialVerifyError(
      "crp",
      `CRP 拒绝登录（HTTP ${response.status}）${readMessage(text) ?? ""}`.trim(),
    );
  }

  const token = readToken(text);

  if (token === "") {
    throw new CredentialVerifyError(
      "crp",
      "CRP 返回了成功状态，但响应里没有 Token：账号可能没问题，服务端行为与预期不符。",
    );
  }
}

/** Gerrit 的真实认证请求：能列项目就说明这份 HTTP 凭据被接受。 */
export async function verifyGerritLogin(
  username: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<void> {
  const baseUrl = options.baseUrl ?? readBaseUrl("gerrit");
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString("base64")}`;
  let response: Response;

  try {
    response = await fetchImpl(`${baseUrl}/a/projects/`, {
      method: "GET",
      headers: { Authorization: authorization, Accept: "*/*" },
      // 不跟随跳转：Gerrit 把人往登录页跳时，那是凭据没被接受，不是「重定向成功」。
      redirect: "manual",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CredentialVerifyError("gerrit", `连不上 Gerrit：${causeMessage(error)}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  // `redirect: "manual"` 在不同 fetch 实现下给出 3xx 或 status 0，两种都说明凭据没被接受。
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw new CredentialVerifyError(
      "gerrit",
      "Gerrit 没有接受这份 HTTP 凭据：请求被重定向到登录页。HTTP 密码要去 Gerrit 的 " +
        "Settings → HTTP Credentials 生成，不是登录密码。",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CredentialVerifyError(
      "gerrit",
      `Gerrit 拒绝了这个账号（HTTP ${response.status}）。`,
    );
  }

  if (!response.ok) {
    throw new CredentialVerifyError("gerrit", `Gerrit 返回了 HTTP ${response.status}。`);
  }

  // 只验身份，不读项目清单：这个响应可能有几兆，没必要下载。
  await response.body?.cancel().catch(() => undefined);
}

/** 读 CRP 登录响应里的 `Token`；解析不了按空串处理。 */
function readToken(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }

    const token = (parsed as { Token?: unknown }).Token;

    return typeof token === "string" ? token.trim() : "";
  } catch {
    return "";
  }
}

/** 网络错误的可读原因；不带请求头，也就不可能把密码带出去。 */
function causeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "请求超时" : error.message;
  }

  return String(error);
}
