/**
 * 「当前操作人」——前台的调用身份。
 *
 * 契约（`.agents/spec/product/credentials.md` 第六节）按场景分两种身份：
 *
 * | 场景 | 用谁的身份 |
 * | --- | --- |
 * | 页面操作、前台接口 | 当前登录用户 |
 * | 后台作业（build-dispatch / build-poll） | 该提测的创建者 |
 *
 * 后台作业没有请求上下文，拿不到 Cookie，所以它们**不经过这里**，由调用方显式传创建者；
 * 这里只服务那些「谁点的就代表谁去调 CRP / Gerrit」的前台路径。
 *
 * 每个库函数都接受显式的 `userId` 参数，这里只是「没传时的默认值」。好处是脚本、
 * 作业与单测都能给出明确的身份，不必伪造一个请求上下文。
 */

import { CredentialActorError } from "./errors";

/** 当前登录用户的账号 ID。 */
export async function currentActorUserId(): Promise<string> {
  try {
    // 懒加载：`lib/auth/server` 会拉进 `next/headers` 与 Prisma 客户端，而这里被 CRP / Gerrit
    // 客户端引用，那些客户端的单测不需要 Next 的请求上下文。
    const { peekSession } = await import("../auth/server");
    const account = await peekSession();

    if (account !== null) {
      return account.id;
    }
  } catch (error) {
    // 不在请求上下文里（脚本、定时任务）时 `cookies()` 会抛错。翻成一句能直接定位的话，
    // 而不是让调用方看到 Next.js 的内部报错。
    throw new CredentialActorError(
      "无法确定当前操作人：这个调用不在登录会话里。请在调用时显式传入 userId。",
      { cause: error instanceof Error ? error : undefined },
    );
  }

  throw new CredentialActorError(
    "无法确定当前操作人：当前请求没有登录用户。请先登录，或显式传入 userId。",
  );
}
