"use server";

/**
 * 项目经理页的服务端动作：新建、编辑（姓名与邮箱）。
 *
 * 「谁属于哪个工作区」由数据库的行决定（`project_manager.workspace_id`），所以新建只能落在
 * 当前工作区；编辑只改姓名与邮箱，不动工作区归属，也不动名下项目。
 *
 * 权限交给 A6 的 `requireRole()`；失败与校验错误都带着提示跳回本页。
 */

import { redirect } from "next/navigation";

import {
  createManager,
  findManagerRef,
  joinFieldErrors,
  parseManagerInput,
  updateManager,
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

/** 表单里的姓名与邮箱；两处动作共用同一份读法。 */
function readManagerFields(formData: FormData): unknown {
  return {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
}

export async function createManagerAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");

  const allowed = await canManage(workspaceId);

  if (!allowed.ok) {
    redirect(backTo(workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseManagerInput(readManagerFields(formData));

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

/** 编辑：姓名与邮箱一起保存；工作区归属与名下项目不动。 */
export async function updateManagerAction(formData: FormData): Promise<void> {
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

  const parsed = parseManagerInput(readManagerFields(formData));

  if (!parsed.ok) {
    redirect(backTo(workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await updateManager(managerId, parsed.value);
  } catch (error) {
    redirect(backTo(workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(workspaceSlug, { notice: `项目经理「${parsed.value.name}」已保存。` }));
}
