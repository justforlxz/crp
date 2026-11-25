/**
 * 提测相关模块（导入、更新、取消、放弃）共用的一处「按人建 CRP 客户端」。
 *
 * 这四个模块原本各写一份，规则完全一样；改造后多了一层「用谁的凭据」，再各写一份就会出现
 * 「某一处漏传了人名，于是以别人的身份发了请求」——而审计身份正是这一次改造的全部目的。
 *
 * 优先级固定，只有一条链路：
 *
 * 1. 注入了 `network`（单测、e2e）→ 用注入的网络，不读任何凭据，也不需要数据库。
 * 2. 显式给了 `actorUserId` → 用这个人的凭据。
 * 3. 都没有 → 用当前登录用户（前台页面与接口的默认做法）。
 *
 * 缺凭据时抛 `CredentialMissingError`，此时还没发出任何 CRP 请求（CRED-6）。
 */

import {
  createCrpClient,
  createCrpClientForCurrentUser,
  createCrpClientForUser,
  CRP_DEFAULT_BASE_URL,
  type CrpClient,
  type CrpRequestObserver,
} from "../integrations/crp";
import type { BuildNetwork } from "../build";

/** 建客户端需要知道的只有两件事：注入的网络与调用身份。 */
export type ReleaseCrpClientOptions = {
  /** 注入用的网络接线，与 A12 / A17 同一形状。 */
  network?: BuildNetwork;
  /**
   * 这次调用以谁的身份调 CRP。
   *
   * 前台接口（导入、更新、取消、放弃）传当前登录用户，或者不传 —— 不传就按当前登录用户；
   * 单测与后台作业显式传，不依赖请求上下文。
   */
  actorUserId?: string;
};

/** 建一个 CRP 客户端；`onRequest` 用来把请求写进 `crp_call_log`。 */
export async function resolveReleaseCrpClient(
  options: ReleaseCrpClientOptions,
  onRequest?: CrpRequestObserver,
): Promise<CrpClient> {
  const network = options.network;
  const extra = onRequest === undefined ? {} : { onRequest };

  if (network?.crpFetch !== undefined) {
    return createCrpClient({
      baseUrl: network.crpBaseUrl ?? CRP_DEFAULT_BASE_URL,
      token: network.crpToken ?? "injected",
      tokenKey: null,
      fetchImpl: network.crpFetch,
      ...extra,
    });
  }

  return options.actorUserId === undefined
    ? createCrpClientForCurrentUser(extra)
    : createCrpClientForUser(options.actorUserId, extra);
}
