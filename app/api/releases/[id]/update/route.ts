/**
 * 一条提测的增量更新接口（A17）：补包、换包，依赖链自动作废重投。
 *
 * | 请求 | 作用 |
 * | --- | --- |
 * | `GET  /api/releases/{id}/update` | 看能不能改、现在有哪些包、还能补哪些包、每轮更新留痕 |
 * | `POST /api/releases/{id}/update?dryRun=1` | 只算不改：返回「将放弃 N 个、重投 N 个」的清单 |
 * | `POST /api/releases/{id}/update` | 真正执行：作废下游 → 新起轮次 → 重投 |
 *
 * 页面先打 `dryRun` 让人确认一次，再打正式的那一次；两次用的是同一个计算函数，
 * 页面看到的清单与服务端要做的完全一致。
 *
 * 鉴权用用户会话：工作区从提测归属查出，不采信请求里传来的工作区。读取要「只读」及以上，
 * 更新要「开发者」及以上 —— 这个动作会真的删掉 CRP Release、发出新的投递。
 *
 * 「能不能改」由服务端现读 CRP 工作流进度决定（`WorkProgress >= 20` 即已转测），
 * 页面上的禁用只是提示；直接调这个接口也绕不过去。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findReleaseScope } from "@/lib/build";
import { CrpError } from "@/lib/integrations/crp";
import {
  applyReleaseUpdate,
  loadReleaseUpdateView,
  parseReleaseUpdateInput,
  previewReleaseUpdate,
  ReleaseError,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 更新提测要「开发者」：它会删旧 Release、发新 Release。 */
const WRITE_ROLE = "developer" as const;

/** 先查归属再做权限判定；提测不存在与没权限都给 404，不泄露「这条提测存在过」。 */
async function authorize(
  releaseId: string,
  role: typeof WRITE_ROLE | "reader",
): Promise<{ ok: true; accountId: string } | { ok: false; response: NextResponse }> {
  const scope = await findReleaseScope(releaseId);

  if (scope === null) {
    return { ok: false, response: errorJson(404, "release_not_found", "提测记录不存在。") };
  }

  const guard = await requireRole({ scope: "workspace", workspaceId: scope.workspaceId, role });

  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }

  return { ok: true, accountId: guard.auth.account.id };
}

/** `ReleaseError` 翻成接口错误；其余异常交给调用方记日志并给出兜底。 */
function releaseErrorResponse(error: ReleaseError): NextResponse {
  const code =
    error.status === 404
      ? "release_not_found"
      : error.status === 409
        ? "conflict"
        : error.status === 502
          ? "crp_error"
          : "invalid_payload";

  return errorJson(error.status, code, error.message);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(id, "reader");

  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json(await loadReleaseUpdateView(id));
  } catch (error) {
    if (error instanceof ReleaseError) {
      return releaseErrorResponse(error);
    }

    console.error(`[GET /api/releases/${id}/update] 读取更新页数据失败`, error);
    return errorJson(500, "internal_error", "读取更新页数据失败，请查看服务端日志。");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(id, WRITE_ROLE);

  if (!auth.ok) {
    return auth.response;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(400, "invalid_json", "请求体不是合法 JSON。");
  }

  const parsed = parseReleaseUpdateInput(body);

  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "请求体校验未通过。",
          details: parsed.errors,
        },
      },
      { status: 400 },
    );
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  try {
    if (dryRun) {
      return NextResponse.json({
        action: "preview",
        plan: await previewReleaseUpdate(id, parsed.value),
      });
    }

    const result = await applyReleaseUpdate(id, parsed.value, { operatorId: auth.accountId });

    return NextResponse.json({
      action: "update",
      revision: result.revision,
      abandonedCrpReleaseIds: result.abandonedCrpReleaseIds,
      redispatchedPackageNames: result.plan.redispatchedPackageNames,
      plan: result.plan,
      advance: result.advance,
      advanceError: result.advanceError,
    });
  } catch (error) {
    if (error instanceof ReleaseError) {
      return releaseErrorResponse(error);
    }

    if (error instanceof CrpError) {
      // CRP 的原话本来就是写给用户看的（缺凭据、业务拒绝、连不上），原样带出去。
      console.error(`[POST /api/releases/${id}/update] 调 CRP 失败`, error);
      return errorJson(502, "crp_error", error.message);
    }

    console.error(`[POST /api/releases/${id}/update] 更新提测失败`, error);
    return errorJson(500, "internal_error", "更新提测失败，请查看服务端日志。");
  }
}
