/**
 * 「当前在哪个工作区」的唯一一份选法。
 *
 * 受保护页面都要回答这个问题，规则只有一条：先认查询串点名的，再认会话里记住的，最后落到
 * 第一个可访问的工作区。最后这一步是给平台管理员用的 —— 刚注册、刚被提为平台管理员时，会话
 * 还没记住任何工作区，不该停在「先选一个工作区」的空转页上；顶栏的工作区切换仍然可用，
 * 切一下就把会话记住了。
 *
 * 这里只做选择，不读库也不读 Cookie：页面把清单与当前会话传进来，规则本身可以直接单测。
 */

export function pickActiveWorkspace<T extends { id: string; slug: string }>(
  workspaces: readonly T[],
  input: {
    /** 查询串里点名的 slug；没写或写了不存在的，都退回下一条规则。 */
    requestedSlug?: string | undefined;
    /** 会话里记住的工作区 ID；还没记住时为 `null`。 */
    sessionWorkspaceId: string | null;
  },
): T | null {
  const requestedSlug = input.requestedSlug ?? "";

  if (requestedSlug !== "") {
    const requested = workspaces.find((workspace) => workspace.slug === requestedSlug);

    if (requested !== undefined) {
      return requested;
    }
  }

  return (
    workspaces.find((workspace) => workspace.id === input.sessionWorkspaceId) ??
    workspaces.at(0) ??
    null
  );
}

/**
 * 是否渲染工作区切换器。
 *
 * 工作区是数据层的多租户边界，不是界面上的分组维度（MKACG-1017）：账号只属于一个工作区时
 * 没有可切换的对象，渲染一个只有一项的下拉只会把工作区名写到页面上。只有属于两个以上工作区时
 * 才出现切换器。
 *
 * 与 `pickActiveWorkspace` 同一份来源：这条规则写在五个筛选条里各写一遍，迟早有一处漏掉。
 */
export function showsWorkspaceSwitcher(workspaces: readonly unknown[]): boolean {
  return workspaces.length > 1;
}
