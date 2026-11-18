"use server";

/**
 * 项目经理页的服务端动作：新建、改名。
 *
 * 「谁属于哪个工作区」由数据库的行决定（`project_manager.workspace_id`），所以新建只能落在
 * 当前工作区；改名只能改姓名，不动工作区归属，也不动名下项目。
 *
 * 权限交给 A6 的 `requireRole()`；失败与校验错误都带着提示跳回本页。
 */

import { redirect } from "next/navigation";

import {
  createManager,
  findManagerRef,
  joinFieldErrors,
  parseManagerInput,
  renameManager,
} from "@/lib/projects";
import { canManage, messageOf } from "../writeGuard";

function backTo(workspaceSlug: string, notice: { notice?: string; error?: string } = {}): string {
  const params = new URLSearchParams();

  if (workspaceSlug) {
    params.set("workspace", workspaceSlug);
  }

  if (notice.notice !== undefined) {
    params.set("notice", notice.notice);
  }

  if (notice.error !== undefined) {
    params.set("error", notice.error);
  }

  const query = params.toString();
  return query === "" ? "/managers" : `/managers?${query}`;
}

export async function createManagerAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");

  const allowed = await canManage(workspaceId);

  if (!allowed.ok) {
    redirect(backTo(workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseManagerInput({ name: String(formData.get("name") ?? "") });

  if (!parsed.ok) {
    redirect(backTo(workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await createManager(workspaceId, parsed.value);
  } catch (error) {
    redirect(backTo(workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(workspaceSlug, { notice: `项目经理「${parsed.value.name}」已创建。` }));
}

export async function renameManagerAction(formData: FormData): Promise<void> {
  const managerId = String(formData.get("managerId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const ref = await findManagerRef(managerId);

  if (ref === null) {
    redirect(backTo(workspaceSlug, { error: "项目经理不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseManagerInput({ name: String(formData.get("name") ?? "") });

  if (!parsed.ok) {
    redirect(backTo(workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await renameManager(managerId, parsed.value);
  } catch (error) {
    redirect(backTo(workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(workspaceSlug, { notice: `项目经理已改名为「${parsed.value.name}」。` }));
}
