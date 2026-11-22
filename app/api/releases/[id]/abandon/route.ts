/**
 * 放弃一条提测的 CRP 主题（MKACG-950）。
 *
 * `POST /api/releases/{id}/abandon` 只做一件事：把这张提测对应的 Topic 在 CRP 上置为已放弃，
 * 本地状态置 `abandoned`，并留一行审计。**不删任何 Release** —— 逐个删 Release 再放弃 Topic
 * 是投递页的「取消提测」（`POST /api/releases/{id}/dispatch?action=cancel`），两个动作不能混。
 *
 * 鉴权用用户会话：工作区从提测归属查出，不采信请求里传来的工作区。权限对齐「创建提测」，
 * 要「开发者」及以上 —— 这是不可撤销的写操作。提测不存在与没权限一律 404，
 * 不泄露这条提测是否存在。
 *
 * 「已经转测就不能放弃」由服务端现读 CRP 工作流进度判定，页面上的禁用只是提示；
 * 直接调这个接口也绕不过去。同样地，「只对从 CRP 导入的提测生效」也由服务端拦一次：
 * 平台自己创建的提测要连 Release 一起清，走「取消提测」，这里返回 409。
 *
 * 请求体可以为空：要放弃哪一条取自路径里的 id，不采信请求体里的任何字段。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findReleaseScope } from "@/lib/build";
import { CrpError } from "@/lib/integrations/crp";
import {
  abandonReleaseTopic,
  abandonTopicLockReason,
  loadCrpTopicName,
  loadReleaseDetail,
  ReleaseError,
  type AbandonedTopic,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 放弃主题要「开发者」：它与创建提测同一档权限，且不可撤销。 */
const WRITE_ROLE = "developer" as const;

/** 先查归属再做权限判定；提测不存在与没权限都给 404，不泄露「这条提测存在过」。 */
async function authorize(
  releaseId: string,
): Promise<{ ok: true; accountId: string } | { ok: false; response: NextResponse }> {
  const scope = await findReleaseScope(releaseId);

  if (scope === null) {
    return { ok: false, response: errorJson(404, "release_not_found", "提测记录不存在。") };
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: scope.workspaceId,
    role: WRITE_ROLE,
  });

  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }

  return { ok: true, accountId: guard.auth.account.id };
}

/**
 * `ReleaseError` 翻成接口错误，三档映射与 `app/api/releases/[id]/update/route.ts` 完全一致：
 * 404 → `release_not_found`、409 → `conflict`、502 → `crp_error`，其余 `invalid_payload`。
 *
 * 不复用 `lib/releases` 的 `releaseErrorCode()`：那个函数把 502 叫 `upstream_unavailable`，
 * 与本文件与 `docs/API.md` 写的不一致，调用方按文档取 `crp_error` 会接不到。
 */
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

function abandonedJson(result: AbandonedTopic): Record<string, unknown> {
  return {
    action: "abandon_topic",
    releaseId: result.releaseId,
    topicId: result.topicId,
    topicName: result.topicName,
    abandonedAt: result.abandonedAt.toISOString(),
  };
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(id);

  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json(abandonedJson(await abandonReleaseTopic(id, auth.accountId)));
  } catch (error) {
    if (error instanceof ReleaseError) {
      return releaseErrorResponse(error);
    }

    if (error instanceof CrpError) {
      // CRP 的原话本来就是写给用户看的（缺凭据、业务拒绝、连不上），原样带出去。
      console.error(`[POST /api/releases/${id}/abandon] 调 CRP 失败`, error);
      return errorJson(502, "crp_error", error.message);
    }

    console.error(`[POST /api/releases/${id}/abandon] 放弃主题失败`, error);
    return errorJson(500, "internal_error", "放弃主题失败，请查看服务端日志。");
  }
}

/**
 * `GET` 返回确认框要显示的两样东西：Topic ID 与主题名。
 *
 * 页面渲染时已经拿到了这两样，这个接口是给「不经过页面、直接调接口」的调用方用的：
 * 先看一眼要放弃的是哪个主题，再发 `POST`。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const scope = await findReleaseScope(id);

  if (scope === null) {
    return errorJson(404, "release_not_found", "提测记录不存在。");
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: scope.workspaceId,
    role: "reader",
  });

  if (!guard.ok) {
    return guard.response;
  }

  try {
    const detail = await loadReleaseDetail(id);
    const lockReason = abandonTopicLockReason(detail);

    return NextResponse.json({
      releaseId: detail.releaseId,
      source: detail.source,
      status: detail.status,
      topicId: detail.crpTopicId,
      // 只有真要显示确认框时才值得为它读一次 CRP 主题名；读不到也就是 `null`。
      topicName: lockReason === null ? await loadCrpTopicName(detail.crpTopicId, undefined) : null,
      workProgress: detail.workProgress,
      workProgressLabel: detail.workProgressLabel,
      canAbandon: lockReason === null,
      lockReason,
    });
  } catch (error) {
    if (error instanceof ReleaseError) {
      return releaseErrorResponse(error);
    }

    throw error;
  }
}
