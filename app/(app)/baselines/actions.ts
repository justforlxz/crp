"use server";

/**
 * 基线页面用到的服务端动作。
 *
 * 手动刷新调的就是定时任务入口用的那个 `runBaselineSync()`，没有第二份同步逻辑。
 * 结果通过查询参数带回页面：这里没有表单状态，跳一下最简单。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/server";
import { runBaselineSync } from "@/lib/jobs/baseline-sync";

function back(notice: string | null, error: string | null): never {
  const query = error === null ? `notice=${encodeURIComponent(notice ?? "")}` : `error=${encodeURIComponent(error)}`;
  redirect(`/baselines?${query}`);
}

/** 把一次同步的结果写成人能读的一句话。 */
function describe(summary: Awaited<ReturnType<typeof runBaselineSync>>): string {
  const refreshed = summary.packages.length;
  const requests =
    summary.requests === null
      ? "请求数未统计"
      : `本次请求 ${summary.requests.total} 次（CRP ${summary.requests.crp} 次、Shuttle ${summary.requests.shuttle} 次）`;

  return (
    `同步完成：分支列表 ${summary.list.itemCount} 条（本次新标记「已消失」${summary.list.missingCount} 条）；` +
    `刷新 ${refreshed} 条基线的软件包版本，跳过 ${summary.skippedPackageCount} 条；${requests}。`
  );
}

export async function refreshBaselinesAction(): Promise<void> {
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    back(null, "请先登录，再触发基线同步。");
  }

  let summary: Awaited<ReturnType<typeof runBaselineSync>>;

  try {
    // 手动刷新不看缓存是否过期：点了按钮就该真去问一次。
    summary = await runBaselineSync({ trigger: "manual", force: true });
  } catch (error) {
    back(null, `同步失败：${error instanceof Error ? error.message : String(error)}`);
  }

  revalidatePath("/baselines");

  if (summary.list.status === "failed") {
    back(null, `分支列表同步失败，已保留上一次的数据：${summary.list.errorMessage ?? "原因未知"}`);
  }

  const failed = summary.packages.filter((item) => item.status === "failed");

  if (failed.length > 0) {
    back(
      null,
      `部分基线同步失败，已保留上一次的数据：${failed
        .map((item) => `${item.name}（${item.errorMessage ?? "原因未知"}）`)
        .join("；")}`,
    );
  }

  back(describe(summary), null);
}
