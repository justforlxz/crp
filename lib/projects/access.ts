/**
 * 「这个账号能不能看这个项目」的判定。
 *
 * 单独抽成纯函数是因为它是页面唯一一道能挡住跨工作区读取的关口：页面按 id 直接查库，
 * 一旦判断写漏一个分支，别人手里的项目 id 就能读到别的项目。写成纯函数才能用单测固定住
 * 每一种情况，尤其是「账号不属于任何工作区」这一种 —— `scope.active` 为空时，
 * `project.workspaceId !== scope.active.id` 这种写法会因为短路而整体不成立，页面就照常渲染了。
 *
 * 判定顺序：先看项目在不在，再看账号有没有当前工作区，再看项目是否属于它，最后看软删。
 */

export type ProjectAccessQuery = {
  /** 从库里查到的项目；不存在为 `null`。 */
  project: { workspaceId: string; deletedAt: Date | null } | null;
  /** 账号当前选中的工作区；账号不属于任何工作区时为 `null`。 */
  activeWorkspaceId: string | null;
  isPlatformAdmin: boolean;
};

/**
 * 只有「项目存在 + 账号有当前工作区 + 项目就在那个工作区 + （未删除 或 是平台管理员）」才可见。
 *
 * 平台管理员不走捷径：跨工作区访问也要带上那个工作区（`?workspace=<slug>`），
 * 这样「按 id 猜别人的项目」对任何账号都行不通。已删除的项目只给平台管理员翻看，
 * 用来核对历史提测记录指向的项目。
 */
export function canViewProject(query: ProjectAccessQuery): boolean {
  const { project, activeWorkspaceId, isPlatformAdmin } = query;

  if (project === null) {
    return false;
  }

  if (activeWorkspaceId === null) {
    return false;
  }

  if (project.workspaceId !== activeWorkspaceId) {
    return false;
  }

  if (project.deletedAt !== null && !isPlatformAdmin) {
    return false;
  }

  return true;
}
