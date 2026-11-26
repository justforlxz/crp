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
 * | `POST …?action=cancel` | 取消整个提测（逐个删 Release + 放弃 Topic）；只对平台创建的提测，且未转测才允许，判定与页面上的「取消提测」共用一份 |
 *
 * 不拆成三个路径，是因为三件事操作的是同一条提测、鉴权和错误映射完全一样。
 *
 * 鉴权用用户会话：工作区从提测归属查出，不采信请求里传来的工作区。读取要「只读」及以上，
 * 推进、重投、取消要「开发者」及以上 —— 这三个动作会真的向 CRP 建 Topic、发 Release。
 *
 * 这里只做一次推进（`advanceRelease` 一次只往前走一步）。后续推进由 worker 每 2 分钟调一次
 * `runBuildDispatch()` 接着做，所以响应里会说明这次走到哪一步、下一步该等什么。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { credentialErrorResponse } from "@/lib/credentials/http";
import { CrpError } from "@/lib/integrations/crp";
import { requireRole } from "@/lib/auth/server";
import {
  advanceRelease,
  BuildError,
  findReleaseScope,
  listCrpCallLogs,
  loadReleaseDispatch,
  retryFailedTasks,
  type AdvanceResult,
  type CancelResult,
  type RetryResult,
} from "@/lib/build";
import {
  cancelPlatformRelease,
  ReleaseError,
  type CancelReleaseOptions,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 推进、重投、取消都要「开发者」：这些动作会真的往 CRP 发东西。 */
const WRITE_ROLE = "developer" as const;

/** 先查归属再做权限判定；提测不存在与没权限都给 404，不泄露「这条提测存在过」。 */
async function authorize(
  releaseId: string,
  role: typeof WRITE_ROLE | "reader",
): Promise<
  | { ok: true; accountId: string }
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

  return { ok: true, accountId: guard.auth.account.id };
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

/**
 * `ReleaseError` 翻成接口错误，三档映射与 `app/api/releases/[id]/abandon/route.ts` 完全一致：
 * 404 → `release_not_found`、409 → `conflict`、502 → `crp_error`，其余 `invalid_payload`。
 *
 * 照抄那一份、不抽公共函数的原因：`abandon` 与 `update` 各自已经有一份，抽出来会牵动两个
 * 已验收的路由，不属于 MKACG-954 的范围（PL 第四轮明确要求照抄）。
 * 也不复用 `lib/releases` 的 `releaseErrorCode()`：那个函数把 502 叫 `upstream_unavailable`，
 * 与 `docs/API.md` 写的不一致，调用方按文档取 `crp_error` 会接不到。
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

/**
 * `?action=cancel` 的处理体：取消整条提测。
 *
 * 与页面上的「取消提测」走同一道判定（`cancelPlatformRelease`）：来源必须是平台创建、
 * 提测没取消过、现读 CRP 工作流进度未到 20。这个入口以前直接调 `cancelRelease`，
 * 任何「开发者」拿到提测 ID 就能绕过页面删掉已转测的提测与导入主题里的 Release（MKACG-954）。
 *
 * 为什么从 `POST` 里拆出来：鉴权要走 Next 的请求上下文（`lib/auth/server.ts` 的 `cookies()`），
 * node 的测试进程里拿不到，`authorize()` 会把测试挡在门外。拆开之后鉴权仍只在 `POST` 里做一次，
 * 测试直接调这个函数覆盖的是同一段代码。返回值结构与拆分前完全一致。
 */
export async function cancelReleaseResponse(
  releaseId: string,
  /** 注入用：单测换掉 CRP 的网络层，与 `cancelPlatformRelease` 的参数一致。 */
  options: CancelReleaseOptions = {},
): Promise<NextResponse> {
  try {
    const result: CancelResult = await cancelPlatformRelease(releaseId, options);

    return NextResponse.json({
      action: "cancel",
      deletedReleaseIds: result.deletedReleaseIds,
      abandonedTopicId: result.abandonedTopicId,
      failures: result.failures,
    });
  } catch (error) {
    if (error instanceof ReleaseError) {
      return releaseErrorResponse(error);
    }

    throw error;
  }
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
      // 前台接口以当前登录用户的身份调 CRP（契约第六节）。
      const advanced = await advanceRelease(id, { actorUserId: auth.accountId });

      return NextResponse.json({ action: "dispatch", ...advanceJson(advanced) });
    }

    if (action === "retry") {
      const result: RetryResult = await retryFailedTasks(id, { actorUserId: auth.accountId });

      return NextResponse.json({
        action: "retry",
        resetPackageNames: result.resetPackageNames,
        unblockedPackageNames: result.unblockedPackageNames,
        failures: result.failures,
        advance: advanceJson(result.advance),
      });
    }

    if (action === "cancel") {
      // 必须 await：直接 `return` 这个 promise 时 try 已经正常结束，`cancelReleaseResponse`
      // 抛出的非 ReleaseError（并发取消时的 BuildError、写库失败等）会绕过下面那一整段映射，
      // 接口回框架的 500，`releaseErrorResponse` 与文档承诺的状态码都到不了调用方。
      return await cancelReleaseResponse(id, { actorUserId: auth.accountId });
    }

    return errorJson(
      400,
      "invalid_action",
      `未知的操作：${action}。可选 dispatch、retry、cancel。`,
    );
  } catch (error) {
    const credentialResponse = credentialErrorResponse(error);

    if (credentialResponse !== null) {
      return credentialResponse;
    }

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
