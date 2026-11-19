/**
 * 构建投递的定时入口。
 *
 * 本仓库没有常驻调度进程，也不引入队列：由外部定时器（cron 或 systemd timer）每隔几分钟
 * POST 一次这个地址，把在跑的提测各往前推一步。用户手动触发走
 * `POST /api/releases/{id}/dispatch`，两条入口调的是同一个 `advanceRelease()`。
 *
 * 鉴权用独立 token：`Authorization: Bearer <BUILD_DISPATCH_JOB_TOKEN>`，与用户会话无关；
 * 服务端没配置这个变量时一律返回 401，不会退化成「谁都能触发」。
 *
 * 返回体是本轮每条提测的推进结果。个别提测推进失败不影响整体，仍是 200，
 * 失败明细在 `items[].error` 里；只有整轮都跑不起来（数据库异常）才回 500。
 */

import { NextResponse } from "next/server";

import { checkBuildDispatchJobAuth, runBuildDispatch } from "@/lib/jobs/build-dispatch";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const auth = checkBuildDispatchJobAuth(request);

  if (!auth.ok) {
    const message =
      auth.reason === "not_configured"
        ? "接口未配置：服务端缺少环境变量 BUILD_DISPATCH_JOB_TOKEN，暂时拒绝触发投递。"
        : "鉴权失败：请用 Authorization: Bearer <token> 触发。";

    return fail(401, "unauthorized", message);
  }

  try {
    const summary = await runBuildDispatch({ trigger: "schedule" });

    return NextResponse.json(summary);
  } catch (error) {
    console.error("[POST /api/jobs/build-dispatch] 推进失败", error);

    return fail(500, "internal_error", "推进失败，请查看服务端日志。");
  }
}
