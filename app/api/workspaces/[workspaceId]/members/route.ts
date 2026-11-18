/**
 * 成员邀请：平台管理员直接建号并分配到工作区。
 *
 * 两种情形：邮箱已有账号 → 只补一条成员关系，不动原密码；邮箱没有账号 → 建号（带初始密码）再分配。
 * 已经是成员、或并发下被别处抢先建了同一个邮箱/成员关系，都返回 409。
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
import { isWorkspaceRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/server";
import {
  addMembership,
  createAccount,
  findAccountByEmail,
  findMembershipRole,
  findWorkspace,
  isUniqueViolation,
} from "@/lib/auth/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const { workspaceId } = await context.params;
  const guard = await requireRole({ scope: "account", role: "platform_admin" });

  if (!guard.ok) {
    return guard.response;
  }

  if ((await findWorkspace(workspaceId)) === null) {
    return errorJson(404, "workspace_not_found", "工作区不存在");
  }

  const body = await readJsonObject(request);

  if (body === null) {
    return errorJson(400, "invalid_body", "请求体必须是 JSON 对象");
  }

  const email = normalizeEmail(stringField(body, "email"));
  const displayName = stringField(body, "displayName").trim();
  const password = stringField(body, "password");
  const role = stringField(body, "role");

  if (!isValidEmail(email)) {
    return errorJson(400, "invalid_email", "邮箱格式不正确");
  }

  if (!isWorkspaceRole(role)) {
    return errorJson(400, "invalid_role", "角色只能是 project_manager、developer 或 reader");
  }

  try {
    const existing = await findAccountByEmail(email);

    if (existing !== null) {
      if ((await findMembershipRole(existing.id, workspaceId)) !== null) {
        return errorJson(409, "already_member", "这个账号已经是该工作区成员");
      }

      await addMembership({ userId: existing.id, workspaceId, role });

      return NextResponse.json(
        { member: { user: publicAccount(existing), role }, accountCreated: false },
        { status: 201 },
      );
    }

    const passwordError = validatePassword(password);
    if (passwordError !== null) {
      return errorJson(400, "invalid_password", passwordError);
    }

    if (displayName.length === 0) {
      return errorJson(400, "invalid_display_name", "新账号必须填写显示名");
    }

    const account = await createAccount({
      email,
      displayName,
      passwordHash: await hashPassword(password),
    });
    await addMembership({ userId: account.id, workspaceId, role });

    return NextResponse.json(
      { member: { user: publicAccount(account), role }, accountCreated: true },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return errorJson(409, "already_member", "这个账号已经是该工作区成员");
    }

    throw error;
  }
}
