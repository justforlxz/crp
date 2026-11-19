"use server";

/**
 * 构建队列页用到的服务端动作。
 *
 * 「立即轮询」调的就是定时任务入口用的那个 `runBuildPoll()`，没有第二份轮询逻辑。
 * 结果通过查询参数带回页面：这里没有表单状态，跳一下最简单。
 *
 * 手动刷新仍然是服务端写入，不是前端轮询（MUST NOT 用前端轮询驱动状态写入）：
 * 点了按钮才写一次，页面本身依旧只读库。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/server";
import { runBuildPoll } from "@/lib/build";

/** 回到队列页，并带上工作区：多工作区账号点完按钮不该被甩回会话里记住的另一个工作区。 */
function back(workspaceSlug: string, notice: string | null, error: string | null): never {
  const params = new URLSearchParams();

  if (workspaceSlug !== "") {
    params.set("workspace", workspaceSlug);
  }

  if (error === null) {
    params.set("notice", notice ?? "");
  } else {
    params.set("error", error);
  }

  redirect(`/queue?${params.toString()}`);
}

/** 把一轮轮询的结果写成人能读的一句话。 */
function describe(summary: Awaited<ReturnType<typeof runBuildPoll>>): string {
  if (summary.releaseCount === 0) {
    return "轮询完成：当前没有未完结的提测，已完结的不再轮询。";
  }

  const packages = summary.items.reduce((total, item) => total + item.checked, 0);
  const progress = summary.items.filter((item) => item.workProgress !== null).length;

  return (
    `轮询完成：${summary.releaseCount} 条提测、${packages} 个已投递包；` +
    `同步了 ${progress} 条提测的 CRP 工作流进度；` +
    `失败 ${summary.failed} 条（失败的那条状态保持原样）。`
  );
}

/** 参数由页面在表单上绑定（`refreshQueueAction.bind(null, slug)`）。 */
export async function refreshQueueAction(workspaceSlug: string): Promise<void> {
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    back(workspaceSlug, null, "请先登录，再触发轮询。");
  }

  let summary: Awaited<ReturnType<typeof runBuildPoll>>;

  try {
    summary = await runBuildPoll({ trigger: "manual" });
  } catch (error) {
    back(workspaceSlug, null, `轮询失败：${error instanceof Error ? error.message : String(error)}`);
  }

  revalidatePath("/queue");

  const failed = summary.items.filter((item) => item.error !== null);

  if (failed.length > 0) {
    back(
      workspaceSlug,
      null,
      `部分提测轮询失败，状态已保持原样：${failed
        .map((item) => `${item.version}（${item.error ?? "原因未知"}）`)
        .join("；")}`,
    );
  }

  back(workspaceSlug, describe(summary), null);
}
