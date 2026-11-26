/**
 * 外部系统的默认地址与地址环境变量。
 *
 * 单独成一个文件是为了断开 import 环：凭据模块要用这两个地址做「保存前验证」，
 * 而 `lib/integrations/crp/config.ts` 又要按人读凭据 —— 两边互相 import 时，
 * 常量可能拿到 `undefined`，报错会以最难查的方式出现。
 */

import type { CredentialKindName } from "../credentials/kinds";

/** CRP 接口前缀默认值。 */
export const CRP_DEFAULT_BASE_URL = "https://crp.uniontech.com/api";

/** Gerrit 服务地址默认值。 */
export const GERRIT_DEFAULT_BASE_URL = "https://gerrit.uniontech.com";

/** 地址的环境变量名。地址不是个人凭据，留在环境变量里。 */
export const INTEGRATION_BASE_URL_ENV: Record<CredentialKindName, string> = {
  crp: "CRP_BASE_URL",
  gerrit: "GERRIT_BASE_URL",
};

const DEFAULT_BASE_URL: Record<CredentialKindName, string> = {
  crp: CRP_DEFAULT_BASE_URL,
  gerrit: GERRIT_DEFAULT_BASE_URL,
};

/** 读某一套系统的地址：环境变量优先，去掉结尾斜杠，不填用默认值。 */
export function readBaseUrl(
  kind: CredentialKindName,
  source: Record<string, string | undefined> = process.env,
): string {
  const raw = source[INTEGRATION_BASE_URL_ENV[kind]]?.trim();

  return (raw || DEFAULT_BASE_URL[kind]).replace(/\/+$/, "");
}
