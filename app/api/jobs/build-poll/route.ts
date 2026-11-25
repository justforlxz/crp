/**
 * 构建状态轮询的定时入口。
 *
 * 调度由常驻的 `pnpm worker` 进程自己维护：`build-poll` 作业每 5 分钟在进程内直接调用
 * `runBuildPoll()`，把在跑的提测各轮询一遍 —— 回写 Shuttle 的构建结果与 CRP 的工作流进度，
 * 不经过这个接口。这个接口留给手动触发与排障；队列页的「手动刷新」也调同一个函数，
 * 没有第二份轮询逻辑。
 *
 * 鉴权用独立 token：`Authorization: Bearer <BUILD_POLL_JOB_TOKEN>`，与用户会话无关；
 * 服务端没配置这个变量时一律返回 401，不会退化成「谁都能触发」。
 *
 * 返回体是本轮每条提测的轮询结果。个别提测出错不影响整体，仍是 200，
 * 失败明细在 `items[].error` 里，且出错的那条提测状态保持原样；只有整轮都跑不起来才回 500。
 */

import { NextResponse } from "next/server";

import { runBuildPoll } from "@/lib/build";
import { checkBuildPollJobAuth } from "@/lib/jobs/build-poll";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const auth = checkBuildPollJobAuth(request);

  if (!auth.ok) {
    const message =
      auth.reason === "not_configured"
        ? "接口未配置：服务端缺少环境变量 BUILD_POLL_JOB_TOKEN，暂时拒绝触发轮询。"
        : "鉴权失败：请用 Authorization: Bearer <token> 触发。";

    return fail(401, "unauthorized", message);
  }

  try {
    const summary = await runBuildPoll({ trigger: "schedule" });

    return NextResponse.json(summary);
  } catch (error) {
    console.error("[POST /api/jobs/build-poll] 轮询失败", error);

    return fail(500, "internal_error", "轮询失败，请查看服务端日志。");
  }
}
