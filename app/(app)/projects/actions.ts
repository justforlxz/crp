"use server";

/**
 * 项目页的服务端动作：建、改、软删项目，以及清单的加包、移包、改跟踪分支。
 *
 * 两件事在这里统一处理：
 *
 * 1. **权限**：写操作要项目经理角色，判定交给 A6 的 `requireRole()`，这里只把结果翻译成
 *    一句能显示的提示，不自己写角色比较。
 * 2. **工作区归属**：项目类动作的工作区一律从库里查（`findProjectRef`），不信任表单传来的
 *    `workspaceId`；只有新建项目才用传进来的工作区，因为它还没有归属行。
 *
 * 每个动作分两层，因为这批动作有两个入口（MKACG-1010）：
 *
 * - `apply*` 只做「权限 → 校验 → 写库 → 一句话结果」，**不跳转**。返回结果而不是直接跳走，
 *   是为了项目弹窗：一个写库动作不该把用户切 tab 时填了一半的草稿连带清掉。
 * - 导出的 `*Action` 是跳转族，项目详情页（`/projects/<id>`）与新建页的表单在用，写完带提示
 *   跳回原页面 —— 与改造前的行为一致。
 *
 * 提示一律走「返回一句话」，由入口决定放进查询串还是交给轻提示，动作自己不认识页面。
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

/**
 * 写库的结果。
 *
 * `notFound` 只在「项目不存在」时为真：跳转族据此把用户送回项目列表（留在
 * `/projects/<不存在的 id>` 只会得到 404，看不到提示），其余失败留在原页面。
 */
export type ProjectMutationResult =
  | { ok: true; message: string }
  | { ok: false; message: string; notFound?: true };

/** 项目的基本字段。弹窗里的草稿与页面上的表单是同一个形状，校验只有一份。 */
export type ProjectFields = {
  name: string;
  key: string;
  projectManagerId: string;
  baselineId: string;
  description: string;
};

type ProjectRef = NonNullable<Awaited<ReturnType<typeof findProjectRef>>>;

type RefResult =
  | { ok: true; ref: ProjectRef }
  | { ok: false; message: string; notFound?: true };

/** 项目是否存在 + 当前账号能不能改它。所有按项目 id 的动作都先过这一关。 */
async function loadManageableProject(projectId: string): Promise<RefResult> {
  const ref = await findProjectRef(projectId);

  if (ref === null) {
    return { ok: false, message: "项目不存在。", notFound: true };
  }

  const allowed = await canManage(ref.workspaceId);

  if (!allowed.ok) {
    return { ok: false, message: allowed.message };
  }

  return { ok: true, ref };
}

// ---------------------------------------------------------------------------
// 不跳转的写库动作（项目弹窗在用）
// ---------------------------------------------------------------------------

/** 新建项目。`workspaceId` 由调用方给，因为它还没有归属行可查。 */
export async function applyCreateProject(
  workspaceId: string,
  fields: ProjectFields,
): Promise<ProjectMutationResult> {
  const allowed = await canManage(workspaceId);

  if (!allowed.ok) {
    return { ok: false, message: allowed.message };
  }

  const parsed = parseProjectInput(fields);

  if (!parsed.ok) {
    return { ok: false, message: joinFieldErrors(parsed.errors) };
  }

  try {
    await createProject(workspaceId, parsed.value);
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  return { ok: true, message: `项目「${parsed.value.name}」已创建。` };
}

/** 改项目的基本信息。项目标识在弹窗里是只读的，仍原样回传一遍。 */
export async function applyUpdateProject(
  projectId: string,
  fields: ProjectFields,
): Promise<ProjectMutationResult> {
  const guard = await loadManageableProject(projectId);

  if (!guard.ok) {
    return guard;
  }

  const parsed = parseProjectInput(fields);

  if (!parsed.ok) {
    return { ok: false, message: joinFieldErrors(parsed.errors) };
  }

  try {
    await updateProject(projectId, parsed.value);
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  return { ok: true, message: "项目已保存。" };
}

/** 软删项目：只动平台里的配置，历史提测记录照旧可查。 */
export async function applyDeleteProject(projectId: string): Promise<ProjectMutationResult> {
  const guard = await loadManageableProject(projectId);

  if (!guard.ok) {
    return guard;
  }

  try {
    await softDeleteProject(projectId);
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  return { ok: true, message: `项目「${guard.ref.name}」已删除。历史提测记录仍可查看。` };
}

/** 往清单里加一个软件包；跟踪分支先取软件包的默认分支。 */
export async function applyAddSoftware(
  projectId: string,
  packageId: string,
  trackedBranch: string,
): Promise<ProjectMutationResult> {
  const guard = await loadManageableProject(projectId);

  if (!guard.ok) {
    return guard;
  }

  const parsed = parseProjectSoftwareInput({ packageId, trackedBranch });

  if (!parsed.ok) {
    return { ok: false, message: joinFieldErrors(parsed.errors) };
  }

  try {
    await addProjectSoftware({
      projectId,
      packageId: parsed.value.packageId,
      trackedBranch: parsed.value.trackedBranch,
    });
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  return { ok: true, message: "已加入项目软件清单。" };
}

/** 从清单里移出一个软件包。 */
export async function applyRemoveSoftware(
  projectId: string,
  packageId: string,
): Promise<ProjectMutationResult> {
  const guard = await loadManageableProject(projectId);

  if (!guard.ok) {
    return guard;
  }

  try {
    await removeProjectSoftware({ projectId, packageId });
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  return { ok: true, message: "已从项目软件清单移除。" };
}

// ---------------------------------------------------------------------------
// 跳转族：项目详情页与新建页的表单在用，写完带提示跳回原页面
// ---------------------------------------------------------------------------

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

function readProjectFields(formData: FormData): ProjectFields {
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
  const result = await applyCreateProject(workspaceId, readProjectFields(formData));

  if (!result.ok) {
    redirect(backTo("/projects/new", workspaceSlug, { error: result.message }));
  }

  redirect(backTo("/projects", workspaceSlug, { notice: result.message }));
}

export async function updateProjectAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const result = await applyUpdateProject(projectId, readProjectFields(formData));

  if (!result.ok) {
    redirect(
      backTo(result.notFound === true ? "/projects" : `/projects/${projectId}`, workspaceSlug, {
        error: result.message,
      }),
    );
  }

  redirect(backTo(`/projects/${projectId}`, workspaceSlug, { notice: result.message }));
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const result = await applyDeleteProject(projectId);

  if (!result.ok) {
    redirect(
      backTo(result.notFound === true ? "/projects" : `/projects/${projectId}`, workspaceSlug, {
        error: result.message,
      }),
    );
  }

  redirect(backTo("/projects", workspaceSlug, { notice: result.message }));
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
  const result = await applyAddSoftware(
    projectId,
    String(formData.get("packageId") ?? ""),
    String(formData.get("trackedBranch") ?? ""),
  );

  if (!result.ok) {
    redirect(
      backTo(result.notFound === true ? "/projects" : `/projects/${projectId}`, workspaceSlug, {
        error: result.message,
      }),
    );
  }

  redirect(backTo(`/projects/${projectId}`, workspaceSlug, { notice: result.message }));
}

export async function removeSoftwareAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const result = await applyRemoveSoftware(projectId, String(formData.get("packageId") ?? ""));

  if (!result.ok) {
    redirect(
      backTo(result.notFound === true ? "/projects" : `/projects/${projectId}`, workspaceSlug, {
        error: result.message,
      }),
    );
  }

  redirect(backTo(`/projects/${projectId}`, workspaceSlug, { notice: result.message }));
}

export async function updateSoftwareBranchAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const guard = await loadManageableProject(projectId);

  if (!guard.ok) {
    redirect(
      backTo(guard.notFound === true ? "/projects" : `/projects/${projectId}`, workspaceSlug, {
        error: guard.message,
      }),
    );
  }

  const parsed = parseProjectSoftwareInput({
    packageId: String(formData.get("packageId") ?? ""),
    trackedBranch: String(formData.get("trackedBranch") ?? ""),
  });

  if (!parsed.ok) {
    redirect(backTo(`/projects/${projectId}`, workspaceSlug, { error: joinFieldErrors(parsed.errors) }));
  }

  try {
    await updateProjectSoftwareBranch({
      projectId,
      packageId: parsed.value.packageId,
      trackedBranch: parsed.value.trackedBranch,
    });
  } catch (error) {
    redirect(backTo(`/projects/${projectId}`, workspaceSlug, { error: messageOf(error) }));
  }

  redirect(backTo(`/projects/${projectId}`, workspaceSlug, { notice: "跟踪分支已保存。" }));
}
