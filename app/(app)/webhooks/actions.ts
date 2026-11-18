"use server";

/**
 * 端点管理页的服务端动作：新建端点、启停端点、发送测试事件。
 *
 * 校验失败时带着可读的提示跳回本页，不把异常直接抛到页面上。
 * 权限校验留给 `app/(app)/layout.tsx`（A6 节点的会话与角色守卫），这里不重复实现。
 */

import { redirect } from "next/navigation";

import { createWebhookEndpoint, setWebhookEndpointEnabled } from "@/lib/webhook/endpoints";
import { sendTestEvent } from "@/lib/webhook/service";
import { WebhookInputError } from "@/lib/webhook/validation";

function backTo(
  workspaceSlug: string,
  query: { notice?: string; error?: string } = {},
): string {
  const params = new URLSearchParams({ workspace: workspaceSlug });

  if (query.notice !== undefined) {
    params.set("notice", query.notice);
  }

  if (query.error !== undefined) {
    params.set("error", query.error);
  }

  return `/webhooks?${params.toString()}`;
}

function messageOf(error: unknown): string {
  if (error instanceof WebhookInputError) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

export async function createEndpointAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");

  let error: string | null = null;

  try {
    await createWebhookEndpoint({
      workspaceId,
      name: String(formData.get("name") ?? ""),
      url: String(formData.get("url") ?? ""),
      secret: String(formData.get("secret") ?? ""),
      description: String(formData.get("description") ?? ""),
      eventTypes: formData.getAll("eventTypes").map((value) => String(value)),
    });
  } catch (caught) {
    error = messageOf(caught);
  }

  redirect(
    error === null
      ? backTo(workspaceSlug, { notice: "端点已保存。" })
      : backTo(workspaceSlug, { error }),
  );
}

export async function toggleEndpointAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";

  let error: string | null = null;

  try {
    await setWebhookEndpointEnabled(id, enabled);
  } catch (caught) {
    error = messageOf(caught);
  }

  redirect(
    error === null
      ? backTo(workspaceSlug, { notice: enabled ? "端点已启用。" : "端点已停用。" })
      : backTo(workspaceSlug, { error }),
  );
}

export async function sendTestEventAction(formData: FormData): Promise<void> {
  const endpointId = String(formData.get("id") ?? "");
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "");

  let error: string | null = null;

  try {
    const result = await sendTestEvent(endpointId);

    if (result.deliveryIds.length === 0) {
      error = "这个端点没有收到测试事件：它可能已被停用。";
    }
  } catch (caught) {
    error = messageOf(caught);
  }

  // 投递在后台跑，这里不等结果；刷新后到投递日志里看。
  redirect(
    error === null
      ? backTo(workspaceSlug, { notice: "测试事件已发出，稍后刷新查看投递日志。" })
      : backTo(workspaceSlug, { error }),
  );
}
