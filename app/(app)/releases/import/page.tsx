import Link from "next/link";

import { listBaselines } from "@/lib/baselines";
import { listReleaseProjectChoices } from "@/lib/releases";
import { resolveWorkspaceScope } from "../../workspaceScope";
import { ImportWizard } from "./wizard";

// 项目、基线状态与 CRP 主题都在变，页面不做静态化。
export const dynamic = "force-dynamic";

type ImportReleasePageProps = {
  searchParams: Promise<{ workspace?: string }>;
};

/**
 * 从 CRP 导入已有提测主题的入口页。
 *
 * 三步全部在客户端向导里走（`wizard.tsx`）：找主题 → 选项目 → 映射预览。
 * 这里只准备两份下拉数据：可导入的项目，以及可用于搜索主题的基线（要拿它的 CRP 分支 ID）。
 */
export default async function ImportReleasePage({ searchParams }: ImportReleasePageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/releases/import", query.workspace);

  if (scope.active === null) {
    return (
      <main>
        <h1>从 CRP 导入</h1>
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </main>
    );
  }

  const [projects, baselines] = await Promise.all([
    listReleaseProjectChoices(scope.active.id),
    listBaselines(),
  ]);

  if (projects.length === 0) {
    return (
      <main>
        <h1>从 CRP 导入</h1>
        <p>
          这个工作区还没有项目，导入的提测要挂在项目上。先去
          <Link href={`/projects/new${scope.query}`}>新建项目</Link>
          ，配好软件清单与基线再回来。
        </p>
      </main>
    );
  }

  return (
    <ImportWizard
      projects={projects}
      baselines={baselines.map((item) => ({
        id: item.id,
        crpBranchId: item.crpBranchId,
        name: item.name,
      }))}
      workspaceQuery={scope.query}
    />
  );
}
