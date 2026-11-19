/**
 * 「这个账号能不能看这条提测」的判定。
 *
 * 更新页（`app/(app)/releases/[id]/update`）按 id 直接查库，这一处判断就是跨工作区读取的唯一关口：
 * 一旦判漏一个分支，别人手里的提测 id 就能读出项目键与名称、提测版本、软件包名、分支、Commit、
 * 代码版本、CRP Topic 与工作流进度，以及每轮更新的操作人姓名。
 *
 * 口径与项目详情页（`lib/projects/access.ts`）保持一致，包括两条容易被写漏的分支：
 *
 * - 账号不属于任何工作区时，`activeWorkspaceId` 是 `null`；这时任何提测都不可见，
 *   不能用「`undefined !== id` 为真」之类的短路把它放过去；
 * - 平台管理员也不走捷径：要看别的工作区的提测，得先切到那个工作区（`?workspace=<slug>`）。
 *
 * 写成纯函数是为了能用单测固定住每一种情况。
 */

export type ReleaseAccessQuery = {
  /** 提测的归属工作区；提测不存在为 `null`。 */
  release: { workspaceId: string } | null;
  /** 账号当前选中的工作区；账号不属于任何工作区时为 `null`。 */
  activeWorkspaceId: string | null;
};

/** 只有「提测存在 + 账号有当前工作区 + 提测就在那个工作区」才可见。 */
export function canViewRelease(query: ReleaseAccessQuery): boolean {
  if (query.release === null) {
    return false;
  }

  if (query.activeWorkspaceId === null) {
    return false;
  }

  return query.release.workspaceId === query.activeWorkspaceId;
}
