/**
 * `app/(app)` 下写操作共用的两件小事：角色判定与错误文案。
 *
 * 项目页与项目经理页的动作完全一样地需要它们，抽成一份，避免两条入口各写一遍、日后改一处漏一处。
 *
 * `canManage` 只负责调用 A6 的 `requireRole()` 并把它的 JSON 响应翻成一句能显示的话，
 * 不自己比较角色高低 —— 角色的定义与判定只应该有一处。
 */
import { requireRole } from "@/lib/auth/server";
import { ProjectError } from "@/lib/projects";

export type WriteGuard = { ok: true } | { ok: false; message: string };

/**
 * 当前账号在这个工作区里是否至少是项目经理。
 *
 * 拦下时返回可以原样显示在页面上的话：401/403/404 的文案都来自 `requireRole()`，
 * 这里只在响应体读不出来时给一句兜底。
 */
export async function canManage(
  workspaceId: string,
  role: "project_manager" = "project_manager",
): Promise<WriteGuard> {
  let guard: Awaited<ReturnType<typeof requireRole>>;

  try {
    guard = await requireRole({ scope: "workspace", workspaceId, role });
  } catch (error) {
    // 角色判定要读会话与成员关系，数据库不可用时会在这里抛错。抛出去就是一张没有提示的 500，
    // 所以这里按「不放行」处理并给一句能显示的话；写操作不会被执行。
    console.error("写操作的角色判定失败：", error);
    return { ok: false, message: "系统暂时不可用，请稍后再试。" };
  }

  if (guard.ok) {
    return { ok: true };
  }

  const body: unknown = await guard.response.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? ((body.error as { message?: string }).message ?? "当前角色不能执行这个操作。")
      : "当前角色不能执行这个操作。";

  return { ok: false, message };
}

/**
 * 业务错误用它的原话；其余异常只记服务端日志、页面上一句兜底。
 *
 * 兜底不返回 `error.message`：那可能是数据库或 Prisma 的原始报错（表名、约束名、SQL 片段），
 * 这些信息属于服务端排障，不该出现在页面提示里。
 */
export function messageOf(error: unknown): string {
  if (error instanceof ProjectError) {
    return error.message;
  }

  console.error("项目相关写操作失败：", error);
  return "操作失败，请稍后重试。";
}
