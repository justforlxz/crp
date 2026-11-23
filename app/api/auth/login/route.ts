/**
 * 登录：邮箱 + password，成功后发 httpOnly Cookie。
 *
 * 三条约定：失败回应不区分「邮箱不存在」与「password不对」；同一账号 1 分钟内失败 5 次后
 * 返回 429；成功登录把失败计数清零。
 */
import { NextResponse } from "next/server";

import { isValidEmail, normalizeEmail, verifyPassword } from "@/lib/auth/credentials";
import { publicAccount } from "@/lib/auth/dto";
import { errorJson, readJsonObject, stringField } from "@/lib/auth/http";
import { createLoginRateLimiter } from "@/lib/auth/rate-limit";
import { attachSessionCookie, startSession } from "@/lib/auth/server";
import { findLoginCandidate } from "@/lib/auth/store";

/** 进程内限流器：单实例部署下这就是唯一的计数来源。 */
const limiter = createLoginRateLimiter();

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonObject(request);

  if (body === null) {
    return errorJson(400, "invalid_body", "请求体必须是 JSON 对象");
  }

  const email = normalizeEmail(stringField(body, "email"));
  const password = stringField(body, "password");
  // 非法邮箱（含超长串）在这里就挡掉：既不查库，也不占限流表的位置。
  if (!isValidEmail(email)) {
    return errorJson(400, "invalid_email", "邮箱格式不正确");
  }

  const now = new Date();
  const gate = limiter.check(email, now);

  if (!gate.allowed) {
    const response = errorJson(429, "too_many_attempts", "尝试次数过多，请稍后再试");
    response.headers.set("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000)));
    return response;
  }

  const candidate = await findLoginCandidate(email);
  const matched =
    candidate !== null && (await verifyPassword(candidate.passwordHash, password));

  if (candidate === null || !matched) {
    limiter.recordFailure(email, now);
    return errorJson(401, "invalid_credentials", "邮箱或密码不正确");
  }

  limiter.reset(email);

  const session = await startSession(candidate.account.id, now);
  return attachSessionCookie(
    NextResponse.json({ user: publicAccount(candidate.account) }, { status: 200 }),
    session,
    request,
    now,
  );
}
