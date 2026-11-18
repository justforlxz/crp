"use server";

/**
 * 创建提测页的服务端动作：从 Gerrit 刷新分支与提交、读某个提交的代码版本。
 *
 * 这一层只做两件事：判定权限、把库函数的结果原样交回客户端。业务组装在
 * `lib/releases/refresh.ts`，请求本身在 `lib/releases/gerrit.ts` —— 分开是为了能
 * 直接用假 Gerrit 客户端跑集成测试。
 *
 * 工作区从项目归属查出（`findReleaseProjectRef`），不采信页面传来的工作区。
 * 失败时返回一句能显示的话，不把异常抛到客户端。
 * 提交提测本身不走这里，走 `POST /api/releases`：阻断条件必须在接口里再判一次。
 */

import { requireRole } from "@/lib/auth/server";
import { isCommitSha } from "@/lib/integrations/gerrit";
import {
  findProjectPackage,
  findReleaseProjectRef,
  loadBranchCommits,
  loadReleaseProject,
  readCommitCodeVersion,
  refreshProjectPackages,
  type PackageRefresh,
  type ReleaseReadiness,
} from "@/lib/releases";

/** 提测创建需要工作区里的「开发者」角色，与 `POST /api/releases` 一致。 */
const REQUIRED_ROLE = "developer" as const;

export type RefreshResult =
  | {
      ok: true;
      projectName: string;
      baselineName: string;
      readiness: ReleaseReadiness;
      packages: PackageRefresh[];
    }
  | { ok: false; message: string };

export type CommitListResult =
  | {
      ok: true;
      commits: PackageRefresh["commits"];
      selected: PackageRefresh["selected"];
    }
  | { ok: false; message: string };

export type ChangelogResult = { ok: true; codeVersion: string } | { ok: false; message: string };

/** 权限判定：工作区里至少是开发者。拦下时给出可以直接显示的话。 */
async function assertCanRead(
  projectId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const ref = await findReleaseProjectRef(projectId);

  if (ref === null) {
    return { ok: false, message: "项目不存在。" };
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: ref.workspaceId,
    role: REQUIRED_ROLE,
  });

  if (guard.ok) {
    return { ok: true };
  }

  const body: unknown = await guard.response.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? ((body.error as { message?: string }).message ?? "当前角色不能创建提测。")
      : "当前角色不能创建提测。";

  return { ok: false, message };
}

/** 从 Gerrit 刷新整个项目的软件包数据（分支、提交、代码版本、基线仓库版本）。 */
export async function refreshProjectPackagesAction(projectId: string): Promise<RefreshResult> {
  const allowed = await assertCanRead(projectId);

  if (!allowed.ok) {
    return { ok: false, message: allowed.message };
  }

  const project = await loadReleaseProject(projectId);

  if (project === null) {
    return { ok: false, message: "项目不存在。" };
  }

  return {
    ok: true,
    projectName: project.name,
    baselineName: project.baseline.name,
    readiness: project.readiness,
    packages: await refreshProjectPackages(project),
  };
}

/** 切分支：列出该分支的提交，并默认选中最新一条（代码版本随之重读）。 */
export async function loadPackageCommitsAction(
  projectId: string,
  packageName: string,
  branch: string,
): Promise<CommitListResult> {
  const allowed = await assertCanRead(projectId);

  if (!allowed.ok) {
    return { ok: false, message: allowed.message };
  }

  if (branch.trim() === "") {
    return { ok: false, message: "请选择一个分支。" };
  }

  const project = await loadReleaseProject(projectId);
  const pkg = project === null ? null : findProjectPackage(project, packageName);

  if (pkg === null) {
    return { ok: false, message: `项目清单里没有「${packageName}」这个软件包。` };
  }

  try {
    const { commits, selected } = await loadBranchCommits(pkg.repoPath, branch);
    return { ok: true, commits, selected };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "读取 Gerrit 失败，请稍后重试。",
    };
  }
}

/** 切 Commit：读这个提交的 `debian/changelog` 版本。 */
export async function readPackageChangelogAction(
  projectId: string,
  packageName: string,
  commitSha: string,
): Promise<ChangelogResult> {
  const allowed = await assertCanRead(projectId);

  if (!allowed.ok) {
    return { ok: false, message: allowed.message };
  }

  if (!isCommitSha(commitSha)) {
    // 分支名会被 A3 的 normalizeRef() 当成分支去查，读出来的是那条分支的最新版本，
    // 不是所选提交的版本。这里先拦住，不把错的版本显示到第二步。
    return { ok: false, message: `Commit 必须是十六进制提交号（7 位以上），当前是：${commitSha}。` };
  }

  const project = await loadReleaseProject(projectId);
  const pkg = project === null ? null : findProjectPackage(project, packageName);

  if (pkg === null) {
    return { ok: false, message: `项目清单里没有「${packageName}」这个软件包。` };
  }

  try {
    return { ok: true, codeVersion: await readCommitCodeVersion(pkg.repoPath, commitSha) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "读取 Gerrit 失败，请稍后重试。",
    };
  }
}
