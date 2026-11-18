/**
 * 外部系统登记软件包的接口。
 *
 * 只有 POST 一个动作，鉴权用独立 token（`Authorization: Bearer <PACKAGE_API_TOKEN>`），
 * 不读用户会话。请求体可以是单条对象，也可以是数组；按 `name` 幂等 —— 同名更新，
 * 不会插出第二条记录。请求体、返回体与错误码见 `docs/API.md`。
 */

import { NextResponse } from "next/server";

import {
  checkPackageApiAuth,
  PackageError,
  parsePackagePayload,
  upsertPackages,
} from "@/lib/packages";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

export async function POST(request: Request) {
  const auth = checkPackageApiAuth(request);

  if (!auth.ok) {
    const message =
      auth.reason === "not_configured"
        ? "接口未配置：服务端缺少环境变量 PACKAGE_API_TOKEN，暂时拒绝对外写入。"
        : "鉴权失败：请用 Authorization: Bearer <token> 提交。";

    return fail(401, "unauthorized", message);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json", "请求体不是合法 JSON。");
  }

  const parsed = parsePackagePayload(body);

  if (!parsed.ok) {
    return fail(400, "invalid_payload", "请求体校验未通过。", parsed.errors);
  }

  try {
    const result = await upsertPackages(parsed.value);

    return NextResponse.json(
      {
        created: result.created,
        updated: result.updated,
        total: result.created.length + result.updated.length,
      },
      { status: result.created.length > 0 ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof PackageError) {
      return fail(
        error.status,
        error.status === 409 ? "conflict" : "invalid_payload",
        error.message,
      );
    }

    console.error("[POST /api/packages] 写入失败", error);
    return fail(500, "internal_error", "写入软件包失败，请查看服务端日志。");
  }
}
