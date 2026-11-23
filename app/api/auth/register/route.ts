/**
 * 注册：邮箱 + password 建账号，成功即登录（种子里那批账号是演示数据，不能登录）。
 *
 * 新账号不属于任何工作区，工作区归属由平台管理员在「成员」接口里分配。
 */
import { NextResponse } from "next/server";

import {
  hashPassword,
  isValidEmail,
  normalizeEmail,
  validatePassword,
} from "@/lib/auth/credentials";
import { publicAccount } from "@/lib/auth/dto";
import { errorJson, readJsonObject, stringField } from "@/lib/auth/http";
import { attachSessionCookie, startSession } from "@/lib/auth/server";
import { createAccount, findAccountByEmail, isUniqueViolation } from "@/lib/auth/store";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonObject(request);

  if (body === null) {
    return errorJson(400, "invalid_body", "请求体必须是 JSON 对象");
  }

  const email = normalizeEmail(stringField(body, "email"));
  const displayName = stringField(body, "displayName").trim();
  const password = stringField(body, "password");

  if (!isValidEmail(email)) {
    return errorJson(400, "invalid_email", "邮箱格式不正确");
  }

  if (displayName.length === 0) {
    return errorJson(400, "invalid_display_name", "请填写显示名");
  }

  const passwordError = validatePassword(password);
  if (passwordError !== null) {
    return errorJson(400, "invalid_password", passwordError);
  }

  if ((await findAccountByEmail(email)) !== null) {
    return errorJson(409, "email_taken", "这个邮箱已经注册");
  }

  let account;
  try {
    account = await createAccount({
      email,
      displayName,
      passwordHash: await hashPassword(password),
    });
  } catch (error) {
    // 唯一索引是最终裁判：两个请求同时注册同一邮箱时，后到的那个也返回 409。
    if (isUniqueViolation(error)) {
      return errorJson(409, "email_taken", "这个邮箱已经注册");
    }

    throw error;
  }

  const session = await startSession(account.id);
  return attachSessionCookie(
    NextResponse.json({ user: publicAccount(account) }, { status: 201 }),
    session,
    request,
  );
}
