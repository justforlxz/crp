/**
 * Shuttle 客户端自己的配置。
 *
 * 与 CRP 的凭据完全分开：这里只读 `SHUTTLE_*` 变量，不读任何 `CRP_*` 变量，
 * 也不复用 CRP 的 token。当前用到的三个读取接口（`/repo/info`、`/task/list`、
 * `/job/log`）实测无需认证，所以 `SHUTTLE_TOKEN` 可以不配；配了才随请求发出。
 */

/** 实测可用的 Shuttle 接口前缀。 */
export const SHUTTLE_DEFAULT_BASE_URL = "https://shuttle.uniontech.com/api/shuttle";

export type ShuttleEnv = {
  /** 接口前缀，默认 `SHUTTLE_DEFAULT_BASE_URL`。 */
  baseUrl: string;
  /** 可选的 Bearer token；当前读取接口不需要。 */
  token?: string;
};

export function readShuttleEnv(
  source: Record<string, string | undefined> = process.env,
): ShuttleEnv {
  const baseUrl = source.SHUTTLE_BASE_URL?.trim() || SHUTTLE_DEFAULT_BASE_URL;
  const token = source.SHUTTLE_TOKEN?.trim();

  return token ? { baseUrl, token } : { baseUrl };
}
