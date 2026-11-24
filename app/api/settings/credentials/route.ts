/**
 * 「我的账号」接口：读写当前登录用户自己的 CRP 与 Gerrit 凭据。
 *
 * 契约见 `.agents/spec/product/credentials.md` 第八节：
 *
 * | 请求 | 作用 |
 * | --- | --- |
 * | `GET /api/settings/credentials` | 两类凭据的当前状态 |
 * | `POST /api/settings/credentials` | 保存并验证（成功后入库） |
 * | `DELETE /api/settings/credentials?kind=crp` | 删掉某一类凭据，回到未配置 |
 *
 * 三条硬约束：
 *
 * 1. **永远只操作当前登录用户自己的凭据。** 账号从会话取，请求体里给不了别人的 ID。
 * 2. **响应里没有密码。** 只返回「是否已配置、账号名、最后验证时间、最后错误」；
 *    这一层直接用 `CredentialView`，密文列在查询时就没读出来（CRED-2）。
 * 3. **保存先验证。** 验证不通过返回 422 与原因，库里不留新记录（CRED-3）。
 */

import { NextResponse } from "next/server";

import { errorJson, readJsonObject, stringField } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import {
  deleteCredential,
  isCredentialKind,
  listCredentialViews,
  saveCredential,
  type CredentialView,
} from "@/lib/credentials";
import { credentialErrorResponse } from "@/lib/credentials/http";

export const dynamic = "force-dynamic";

/** 凭据属于个人，登录即可读写；不存在「别人的凭据」。 */
const REQUIRED_ROLE = "reader" as const;

/**
 * 对外的凭据形态。这是唯一一处把库里的行翻成 JSON 的地方。
 *
 * 导出给单测：CRED-2 要求「响应里没有密码字段」，锁在这里比锁在 HTTP 层更直接。
 */
export function credentialJson(view: CredentialView): Record<string, unknown> {
  return {
    kind: view.kind,
    label: view.label,
    configured: view.configured,
    username: view.username,
    verifiedAt: view.verifiedAt === null ? null : view.verifiedAt.toISOString(),
    lastError: view.lastError,
  };
}

export async function GET(): Promise<NextResponse> {
  const guard = await requireRole({ scope: "account", role: REQUIRED_ROLE });

  if (!guard.ok) {
    return guard.response;
  }

  const views = await listCredentialViews(guard.auth.account.id);

  return NextResponse.json({ credentials: views.map(credentialJson) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireRole({ scope: "account", role: REQUIRED_ROLE });

  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonObject(request);

  if (body === null) {
    return errorJson(400, "invalid_json", "请求体不是合法 JSON。");
  }

  const kind = stringField(body, "kind");

  if (!isCredentialKind(kind)) {
    return errorJson(400, "invalid_payload", "kind 只能是 crp 或 gerrit。");
  }

  try {
    const view = await saveCredential({
      userId: guard.auth.account.id,
      kind,
      username: stringField(body, "username"),
      secret: stringField(body, "secret"),
    });

    return NextResponse.json(credentialJson(view), { status: 201 });
  } catch (error) {
    const credentialResponse = credentialErrorResponse(error);

    if (credentialResponse !== null) {
      return credentialResponse;
    }

    console.error("[POST /api/settings/credentials] 保存凭据失败", error);
    return errorJson(500, "internal_error", "保存凭据失败，请查看服务端日志。");
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const guard = await requireRole({ scope: "account", role: REQUIRED_ROLE });

  if (!guard.ok) {
    return guard.response;
  }

  const kind = new URL(request.url).searchParams.get("kind");

  if (!isCredentialKind(kind)) {
    return errorJson(400, "invalid_payload", "kind 只能是 crp 或 gerrit。");
  }

  await deleteCredential(guard.auth.account.id, kind);

  return NextResponse.json({ kind, configured: false });
}
