"use server";

/**
 * 详情页的服务端动作。
 *
 * 两件事：
 *
 * - 「CRP 仓库记录」区块的「手动刷新」：调 A12 的 `pollReleaseBuilds(releaseId)`，
 *   不自己写 CRP 请求 —— 轮询的请求顺序、状态回写、`lastSyncedAt` 的写法只有那一份；
 * - 「放弃主题」（MKACG-950）：调 `abandonReleaseTopic`，先 GET 完整对象、只把 `Abandoned`
 *   置真再 PUT，然后回写本地状态与审计行。这里不手搓 CRP 请求，理由同上。
 *
 * 权限与接口侧一致：工作区从提测归属查出（`findReleaseScope`），不采信页面传来的工作区。
 * 读不到归属或没有相应权限都按「不存在」处理，不泄露这条提测是否存在。
 * 刷新只读、只改本地构建状态，只读成员即可；放弃主题是不可撤销的写操作，要和「创建提测」同一档。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { BuildError, findReleaseScope, pollReleaseBuilds } from "@/lib/build";
import { requireRole } from "@/lib/auth/server";
import { CrpError } from "@/lib/integrations/crp";
import { abandonReleaseTopic, ReleaseError } from "@/lib/releases";

/** 刷新只读 CRP、只改本地的构建状态，因此只读成员也可以触发。 */
const REFRESH_ROLE = "reader" as const;

/** 放弃主题会真的改 CRP 上的主题且不能撤销，权限对齐「创建提测」：开发者及以上。 */
const ABANDON_ROLE = "developer" as const;

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

/**
 * 放弃这条提测的 CRP 主题。
 *
 * 只放弃 Topic，不删任何 Release、不动快照 —— 「取消提测」是另一个动作。
 * 能不能放弃由 `abandonReleaseTopic` 现读 CRP 工作流进度后再定一次：页面上的禁用只是提示，
 * 直接提交这个表单也绕不过「已转测就拒绝」。失败时本地状态不动，错误原样回到页面上。
 */
export async function abandonTopicAction(formData: FormData): Promise<void> {
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
    role: ABANDON_ROLE,
  });

  if (!guard.ok) {
    redirect(`/releases?error=${encodeURIComponent("提测记录不存在，或你没有看它的权限。")}`);
  }

  let result: Awaited<ReturnType<typeof abandonReleaseTopic>>;

  try {
    result = await abandonReleaseTopic(releaseId, guard.auth.account.id);
  } catch (error) {
    // ReleaseError 与 CrpError 的消息本来就是写给用户看的，原样显示；其余留给服务端日志。
    const message =
      error instanceof ReleaseError || error instanceof CrpError
        ? error.message
        : "放弃主题失败，请查看服务端日志后重试。";

    if (!(error instanceof ReleaseError) && !(error instanceof CrpError)) {
      console.error(`[releases/${releaseId}] 放弃主题失败`, error);
    }

    back(releaseId, null, message);
  }

  revalidatePath(`/releases/${releaseId}`);
  revalidatePath("/releases");

  back(
    releaseId,
    `已放弃主题 ${result.topicId}${result.topicName === "" ? "" : `「${result.topicName}」`}；` +
      "CRP 侧该主题已标记为放弃，本地这条提测记为已放弃。",
    null,
  );
}
