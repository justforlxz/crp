/**
 * 一条提测的投递接口（A12）。
 *
 * 同一个地址承担三件事，用 `?action=` 区分：
 *
 * | 请求 | 作用 |
 * | --- | --- |
 * | `GET  /api/releases/{id}/dispatch` | 看每个包的投递参数、CRP Release ID、构建状态，以及最近的 CRP 请求记录 |
 * | `POST /api/releases/{id}/dispatch` | 推进一次：建 Topic 或投递下一个包（默认动作） |
 * | `POST …?action=retry` | 重投失败的构建任务（删旧 Release，按同一份快照参数重投） |
 * | `POST …?action=cancel` | 取消整个提测（逐个删 Release + 放弃 Topic） |
 *
 * 不拆成三个路径，是因为三件事操作的是同一条提测、鉴权和错误映射完全一样。
 *
 * 鉴权用用户会话：工作区从提测归属查出，不采信请求里传来的工作区。读取要「只读」及以上，
 * 推进、重投、取消要「开发者」及以上 —— 这三个动作会真的向 CRP 建 Topic、发 Release。
 *
 * 这里只做一次推进（`advanceRelease` 一次只往前走一步）。后续推进由外部定时器反复
 * 调 `/api/jobs/build-dispatch`，所以响应里会说明这次走到哪一步、下一步该等什么。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { CrpError } from "@/lib/integrations/crp";
import { requireRole } from "@/lib/auth/server";
import {
  advanceRelease,
  BuildError,
  cancelRelease,
  findReleaseScope,
  listCrpCallLogs,
  loadReleaseDispatch,
  retryFailedTasks,
  type AdvanceResult,
  type CancelResult,
  type RetryResult,
} from "@/lib/build";

export const dynamic = "force-dynamic";

/** 推进、重投、取消都要「开发者」：这些动作会真的往 CRP 发东西。 */
const WRITE_ROLE = "developer" as const;

/** 先查归属再做权限判定；提测不存在与没权限都给 404，不泄露「这条提测存在过」。 */
async function authorize(
  releaseId: string,
  role: typeof WRITE_ROLE | "reader",
): Promise<
  | { ok: true }
  | { ok: false; response: NextResponse }
> {
  const scope = await findReleaseScope(releaseId);

  if (scope === null) {
    return { ok: false, response: errorJson(404, "release_not_found", "提测记录不存在。") };
  }

  const guard = await requireRole({ scope: "workspace", workspaceId: scope.workspaceId, role });

  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }

  return { ok: true };
}

/** `BuildError` 翻成接口错误；其余异常交给调用方记日志并回 500。 */
function buildErrorResponse(error: BuildError): NextResponse {
  const code =
    error.status === 404 ? "release_not_found" : error.status === 409 ? "conflict" : "invalid_payload";

  return errorJson(error.status, code, error.message);
}

function advanceJson(result: AdvanceResult): Record<string, unknown> {
  return {
    action: result.action,
    status: result.status,
    crpTopicId: result.topicId,
    packageName: result.packageName,
    blocked: result.blocked.map((item) => ({
      packageName: item.packageName,
      blockedByPackage: item.blockedByName,
      reason: item.reason,
    })),
    polled: result.polled,
  };
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
    const [view, crpCalls] = await Promise.all([
      loadReleaseDispatch(id),
      listCrpCallLogs(id),
    ]);

    return NextResponse.json({ ...view, crpCalls });
  } catch (error) {
    if (error instanceof BuildError) {
      return buildErrorResponse(error);
    }

    console.error(`[GET /api/releases/${id}/dispatch] 读取投递详情失败`, error);
    return errorJson(500, "internal_error", "读取投递详情失败，请查看服务端日志。");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const action = new URL(request.url).searchParams.get("action") ?? "dispatch";
  const auth = await authorize(id, WRITE_ROLE);

  if (!auth.ok) {
    return auth.response;
  }

  try {
    if (action === "dispatch") {
      return NextResponse.json({ action: "dispatch", ...advanceJson(await advanceRelease(id)) });
    }

    if (action === "retry") {
      const result: RetryResult = await retryFailedTasks(id);

      return NextResponse.json({
        action: "retry",
        resetPackageNames: result.resetPackageNames,
        unblockedPackageNames: result.unblockedPackageNames,
        failures: result.failures,
        advance: advanceJson(result.advance),
      });
    }

    if (action === "cancel") {
      const result: CancelResult = await cancelRelease(id);

      return NextResponse.json({
        action: "cancel",
        deletedReleaseIds: result.deletedReleaseIds,
        abandonedTopicId: result.abandonedTopicId,
        failures: result.failures,
      });
    }

    return errorJson(
      400,
      "invalid_action",
      `未知的操作：${action}。可选 dispatch、retry、cancel。`,
    );
  } catch (error) {
    if (error instanceof BuildError) {
      return buildErrorResponse(error);
    }

    if (error instanceof CrpError) {
      // CRP 的错误消息本来就是写给用户看的（缺凭据、业务拒绝、连不上），原样带出去，
      // 不要让人为了看原因去翻服务端日志。
      console.error(`[POST /api/releases/${id}/dispatch] 调 CRP 失败`, error);
      return errorJson(502, "crp_error", error.message);
    }

    console.error(`[POST /api/releases/${id}/dispatch] 操作 ${action} 失败`, error);
    return errorJson(502, "crp_error", "向 CRP 投递失败，请查看服务端日志后重试。");
  }
}
