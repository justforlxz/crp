"use server";

/**
 * 项目页的服务端动作：建、改、软删、复制项目，以及清单的加包、移包、改跟踪分支。
 *
 * 两件事在这里统一处理：
 *
 * 1. **权限**：写操作要项目经理角色，判定交给 A6 的 `requireRole()`，这里只把结果翻译成
 *    一句能显示的提示，不自己写角色比较。
 * 2. **工作区归属**：项目类动作的工作区一律从库里查（`findProjectRef`），不信任表单传来的
 *    `workspaceId`；只有新建项目才用表单里的工作区，因为它还没有归属行。
 *
 * 失败时带着可读提示跳回原页面，不把异常抛到页面上；提示走查询串，页面负责显示。
 */

import { redirect } from "next/navigation";

import {
  addProjectSoftware,
  copyProject,
  createProject,
  findProjectRef,
  joinFieldErrors,
  parseProjectInput,
  parseProjectSoftwareInput,
  removeProjectSoftware,
  softDeleteProject,
  updateProject,
  updateProjectSoftwareBranch,
} from "@/lib/projects";
import { canManage, messageOf } from "../writeGuard";

type Notice = { notice?: string; error?: string };

function backTo(path: string, workspaceSlug: string, notice: Notice = {}): string {
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
  return query === "" ? path : `${path}?${query}`;
}

function readProjectFields(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    key: String(formData.get("key") ?? ""),
    projectManagerId: String(formData.get("projectManagerId") ?? ""),
    baselineId: String(formData.get("baselineId") ?? ""),
    description: String(formData.get("description") ?? ""),
  };
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");

  const allowed = await canManage(workspaceId);

  if (!allowed.ok) {
    redirect(backTo("/projects", workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseProjectInput(readProjectFields(formData));

  if (!parsed.ok) {
    redirect(backTo("/projects/new", workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  let createdId: string;

  try {
    const created = await createProject(workspaceId, parsed.value);
    createdId = created.id;
  } catch (error) {
    redirect(backTo("/projects/new", workspaceSlug, { error: messageOf(error) }));
  }

  redirect(
    backTo(`/projects/${createdId}`, workspaceSlug, {
      notice: `项目「${parsed.value.name}」已创建。`,
    }),
  );
}

export async function updateProjectAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const projectPath = `/projects/${projectId}`;
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseProjectInput(readProjectFields(formData));

  if (!parsed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await updateProject(projectId, parsed.value);
  } catch (error) {
    redirect(backTo(projectPath, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(projectPath, workspaceSlug, { notice: "项目已保存。" }));
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(`/projects/${projectId}`, workspaceSlug, { error: allowed.message }));
  }

  try {
    await softDeleteProject(projectId);
  } catch (error) {
    redirect(backTo(`/projects/${projectId}`, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(
    backTo("/projects", workspaceSlug, {
      notice: `项目「${ref.name}」已删除。历史提测记录仍可查看。`,
    }),
  );
}

export async function copyProjectAction(formData: FormData): Promise<void> {
  const sourceProjectId = String(formData.get("sourceProjectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const sourcePath = `/projects/${sourceProjectId}`;
  const ref = await findProjectRef(sourceProjectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "要复制的项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(sourcePath, workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseProjectInput(readProjectFields(formData));

  if (!parsed.ok) {
    redirect(backTo(sourcePath, workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  let createdId: string;

  try {
    const created = await copyProject(sourceProjectId, parsed.value);
    createdId = created.id;
  } catch (error) {
    redirect(backTo(sourcePath, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(
    backTo(`/projects/${createdId}`, workspaceSlug, {
      notice: `已复制为「${parsed.value.name}」，清单已带走，提交历史已清空。`,
    }),
  );
}

export async function addSoftwareAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const projectPath = `/projects/${projectId}`;
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseProjectSoftwareInput({
    packageId: String(formData.get("packageId") ?? ""),
    trackedBranch: String(formData.get("trackedBranch") ?? ""),
  });

  if (!parsed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await addProjectSoftware({
      projectId,
      packageId: parsed.value.packageId,
      trackedBranch: parsed.value.trackedBranch,
    });
  } catch (error) {
    redirect(backTo(projectPath, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(projectPath, workspaceSlug, { notice: "已加入项目软件清单。" }));
}

export async function removeSoftwareAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const packageId = String(formData.get("packageId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const projectPath = `/projects/${projectId}`;
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: allowed.message }));
  }

  try {
    await removeProjectSoftware({ projectId, packageId });
  } catch (error) {
    redirect(backTo(projectPath, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(projectPath, workspaceSlug, { notice: "已从项目软件清单移除。" }));
}

export async function updateSoftwareBranchAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const projectPath = `/projects/${projectId}`;
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    redirect(backTo("/projects", workspaceSlug, { error: "项目不存在。" }));
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: allowed.message }));
  }

  const parsed = parseProjectSoftwareInput({
    packageId: String(formData.get("packageId") ?? ""),
    trackedBranch: String(formData.get("trackedBranch") ?? ""),
  });

  if (!parsed.ok) {
    redirect(backTo(projectPath, workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await updateProjectSoftwareBranch({
      projectId,
      packageId: parsed.value.packageId,
      trackedBranch: parsed.value.trackedBranch,
    });
  } catch (error) {
    redirect(backTo(projectPath, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(projectPath, workspaceSlug, { notice: "跟踪分支已保存。" }));
}
