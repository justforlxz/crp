/**
 * 从 CRP 查项目（MKACG-996）。
 *
 * 页面（`app/(app)/packages`）在输入框里打字时调这里：服务端当场问一次 CRP，把结果整理成
 * 精简字段返回，**不写库**。用来解决「登记软件包时 CRP 项目名到底叫什么」要离开平台去
 * CRP 网站翻的问题。
 *
 * 鉴权走用户会话（登录即可）：只读查询，不区分工作区角色，因为它查的不是本平台的数据。
 * CRP 的调用身份是**当前登录用户**自己的凭据（`.agents/spec/product/credentials.md` 第六节），
 * 没配凭据时在发请求之前就返回 409，让用户去「我的账号」配置。
 *
 * 请求参数、返回体与错误码见 `docs/API.md`。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { credentialErrorResponse } from "@/lib/credentials/http";
import {
  CrpProjectSearchError,
  parseBranchId,
  parseLimit,
  searchCrpProjects,
} from "@/lib/packages";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    // 未登录：与其它接口一致，401 + `unauthenticated`，不返回任何数据。
    return guard.response;
  }

  const url = new URL(request.url);

  try {
    const result = await searchCrpProjects({
      query: url.searchParams.get("q") ?? "",
      limit: parseLimit(url.searchParams.get("limit")),
      branchId: parseBranchId(url.searchParams.get("branchId")),
    });

    return NextResponse.json(result);
  } catch (error) {
    // 没配 CRP 账号：给出「去我的账号配置」（409），而不是一个查不出原因的 502。
    const credentialResponse = credentialErrorResponse(error);

    if (credentialResponse !== null) {
      return credentialResponse;
    }

    if (error instanceof CrpProjectSearchError) {
      return searchErrorResponse(error);
    }

    console.error("[GET /api/crp/projects] 查询 CRP 失败", error);
    return errorJson(500, "internal_error", "查询 CRP 失败，请查看服务端日志。");
  }
}

/**
 * 查询失败 → 响应。`retryAfter`（秒）只在限流时出现，前端靠它显示「约 N 秒后再试」。
 *
 * 同一份秒数也写进 `Retry-After` 响应头：这是 HTTP 的标准位置，写两处不冲突。
 */
function searchErrorResponse(error: CrpProjectSearchError): NextResponse {
  const retryAfter = error.retryAfterSeconds;

  const response = NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(retryAfter === null ? {} : { retryAfter }),
      },
    },
    { status: error.status },
  );

  if (retryAfter !== null) {
    response.headers.set("Retry-After", String(retryAfter));
  }

  return response;
}
