/**
 * 基线同步的定时入口。
 *
 * 本仓库没有常驻调度进程，也不引入队列或额外的调度服务：由外部定时器（cron 或 systemd
 * timer）每小时 POST 一次这个地址。页面上的「立即同步」按钮调的是同一个 `runBaselineSync()`，
 * 两条入口没有第二份同步逻辑。触发方式见 README 的「定时同步」一节。
 *
 * 鉴权用独立 token：`Authorization: Bearer <SYNC_JOB_TOKEN>`，与用户会话无关；
 * 服务端没配置这个变量时一律返回 401，不会退化成「谁都能触发」。
 *
 * 返回体就是这次同步的明细（分支条数、每条基线的结果、请求计数）：
 *
 * - 分支列表同步失败 → 502，方便定时器把这次执行标成失败。
 * - 分支列表成功、个别基线失败 → 200，失败明细在 `packages[]` 里，不阻塞下一轮。
 */

import { NextResponse } from "next/server";

import { checkSyncJobAuth, runBaselineSync } from "@/lib/jobs/baseline-sync";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const auth = checkSyncJobAuth(request);

  if (!auth.ok) {
    const message =
      auth.reason === "not_configured"
        ? "接口未配置：服务端缺少环境变量 SYNC_JOB_TOKEN，暂时拒绝触发同步。"
        : "鉴权失败：请用 Authorization: Bearer <token> 触发。";

    return fail(401, "unauthorized", message);
  }

  try {
    const summary = await runBaselineSync({ trigger: "schedule" });

    return NextResponse.json(summary, { status: summary.list.status === "success" ? 200 : 502 });
  } catch (error) {
    console.error("[POST /api/jobs/baseline-sync] 同步失败", error);

    return fail(500, "internal_error", "同步失败，请查看服务端日志。");
  }
}
