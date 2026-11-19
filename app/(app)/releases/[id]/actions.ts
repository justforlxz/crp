"use server";

/**
 * 详情页的服务端动作。
 *
 * 只有一件事：「CRP 仓库记录」区块的「手动刷新」。它调 A12 的 `pollReleaseBuilds(releaseId)`，
 * 不自己写 CRP 请求 —— 轮询的请求顺序、状态回写、`lastSyncedAt` 的写法只有那一份。
 *
 * 权限与接口侧一致：工作区从提测归属查出（`findReleaseScope`），不采信页面传来的工作区。
 * 读不到归属或没有只读权限都按「不存在」处理，不泄露这条提测是否存在。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { BuildError, findReleaseScope, pollReleaseBuilds } from "@/lib/build";
import { requireRole } from "@/lib/auth/server";

/** 刷新只读 CRP、只改本地的构建状态，因此只读成员也可以触发。 */
const REFRESH_ROLE = "reader" as const;

/** 回到详情页；结果通过查询串带回，页面不需要额外状态。 */
function back(releaseId: string, notice: string | null, error: string | null): never {
  const params = new URLSearchParams();

  if (error === null) {
    params.set("notice", notice ?? "");
  } else {
    params.set("error", error);
  }

  redirect(`/releases/${releaseId}?${params.toString()}`);
}

export async function refreshRepositoryRecordsAction(formData: FormData): Promise<void> {
  const releaseId = String(formData.get("releaseId") ?? "").trim();

  if (releaseId === "") {
    redirect("/releases");
  }

  // 工作区从提测归属查出，不采信页面传来的工作区。
  const scope = await findReleaseScope(releaseId);

  if (scope === null) {
    redirect(`/releases?error=${encodeURIComponent("提测记录不存在，或你没有看它的权限。")}`);
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: scope.workspaceId,
    role: REFRESH_ROLE,
  });

  // 归属查不到与没权限同一口径：都当成「不存在」，不让别人靠这个动作试探出提测是否存在。
  if (!guard.ok) {
    redirect(`/releases?error=${encodeURIComponent("提测记录不存在，或你没有看它的权限。")}`);
  }

  let summary: Awaited<ReturnType<typeof pollReleaseBuilds>>;

  try {
    summary = await pollReleaseBuilds(releaseId);
  } catch (error) {
    const message =
      error instanceof BuildError
        ? error.message
        : `刷新失败：${error instanceof Error ? error.message : String(error)}`;

    back(releaseId, null, message);
  }

  revalidatePath(`/releases/${releaseId}`);

  if (summary.checked === 0) {
    back(
      releaseId,
      null,
      "这个 Topic 里还没有可刷新的 Release：提测还没投递，或者 CRP 侧已经把它们删掉了。",
    );
  }

  const parts = [`刷新 ${summary.checked} 个包的构建状态`];

  if (summary.succeeded.length > 0) {
    parts.push(`成功 ${summary.succeeded.join("、")}`);
  }

  if (summary.failed.length > 0) {
    parts.push(`失败 ${summary.failed.join("、")}`);
  }

  if (summary.building.length > 0) {
    parts.push(`仍在构建 ${summary.building.join("、")}`);
  }

  back(releaseId, `${parts.join("；")}。`, null);
}
