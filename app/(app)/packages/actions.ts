"use server";

/**
 * 软件包页面用到的服务端动作。
 *
 * 表单用 `useActionState` 提交，失败时把 `PackageError` 的话原样交回页面显示
 * （依赖成环的那句「A → B → A」就是这么到人眼前的），成功则刷新页面数据。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createShuttleClient, readShuttleEnv } from "@/lib/integrations/shuttle";
import {
  createPackage,
  deletePackage,
  parsePackageInput,
  PackageError,
  saveDependencies,
  syncPackageMetadata,
  updatePackage,
} from "@/lib/packages";
import { fetchBaselineVersion } from "@/lib/packages/baselineVersion";

export type ActionState = { error?: string; message?: string } | null;

function messageOf(error: unknown): string {
  if (error instanceof PackageError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败，原因未知。";
}

function readForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    repoPath: String(formData.get("repoPath") ?? ""),
    defaultBranch: String(formData.get("defaultBranch") ?? ""),
    currentVersion: String(formData.get("currentVersion") ?? ""),
    // 留空表示与包名相同（表单里那个「CRP 项目名（可不填）」的输入框）。
    crpProjectName: String(formData.get("crpProjectName") ?? ""),
  };
}

/** 新建后跳到详情页，接着就能配依赖。 */
export async function createPackageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = parsePackageInput(readForm(formData));

  if (!parsed.ok) {
    return { error: parsed.errors.map((item) => item.message).join("；") };
  }

  let id: string;

  try {
    const created = await createPackage(parsed.value);
    id = created.id;
  } catch (error) {
    return { error: messageOf(error) };
  }

  revalidatePath("/packages");
  redirect(`/packages/${id}`);
}

export async function updatePackageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const parsed = parsePackageInput(readForm(formData));

  if (!parsed.ok) {
    return { error: parsed.errors.map((item) => item.message).join("；") };
  }

  try {
    await updatePackage(id, parsed.value);
  } catch (error) {
    return { error: messageOf(error) };
  }

  revalidatePath("/packages");
  revalidatePath(`/packages/${id}`);

  return { message: "已保存。" };
}

export async function deletePackageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");

  try {
    await deletePackage(id);
  } catch (error) {
    return { error: messageOf(error) };
  }

  revalidatePath("/packages");
  redirect("/packages");
}

export async function saveDependenciesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const upstreamIds = formData.getAll("upstreamIds").map((item) => String(item));

  try {
    await saveDependencies(id, upstreamIds);
  } catch (error) {
    return { error: messageOf(error) };
  }

  revalidatePath(`/packages/${id}`);
  revalidatePath("/packages");

  return { message: "依赖已保存。" };
}

export async function syncPackageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");

  try {
    const synced = await syncPackageMetadata(id);
    revalidatePath(`/packages/${id}`);
    revalidatePath("/packages");

    return {
      message: `已同步：${synced.defaultBranch} 当前提交 ${synced.currentCommit?.slice(0, 12) ?? "未知"}，版本 ${synced.currentVersion ?? "未知"}。`,
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** 现场问一次 Shuttle：这个包在某个基线交付仓库里的版本是多少。 */
export async function lookupBaselineVersionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const packageName = String(formData.get("packageName") ?? "");
  const baselineName = String(formData.get("baselineName") ?? "");

  if (!baselineName) {
    return { error: "请先选择一个基线。" };
  }

  try {
    const version = await fetchBaselineVersion(createShuttleClient(readShuttleEnv()), {
      baselineName,
      packageName,
    });

    return {
      message: version
        ? `${baselineName} 里 ${packageName} 的仓库版本是 ${version}。`
        : `${baselineName} 里没有查到 ${packageName}，说明这个基线里还没有这个包。`,
    };
  } catch (error) {
    return { error: `查询 Shuttle 失败：${messageOf(error)}` };
  }
}
