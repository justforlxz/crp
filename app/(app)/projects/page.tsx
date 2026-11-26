/**
 * 项目页（MKACG-971 / MKACG-984 按原型重做，MKACG-1010 换成四 tab 弹窗）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目页与 `design.md` 第七节：
 *
 *   `.sec-hd` + `.manager-grid` 经理卡 → `.sec-hd`（带 `.search`）+ `.project-grid` 项目卡 → `.tip`
 *
 * 项目与项目经理都以卡片呈现，页面里没有承载这两类数据的 table 元素（FUNC-10）。
 * 卡片的字段全部来自 `listProjectCards()` / `listManagers()` 已有的数据，不为这张页面新增查询字段。
 *
 * 这一页只取数，交互在 `projectsView.tsx`（客户端）：点项目卡直接打开四 tab 的宽版弹窗，
 * 卡上不再有「...」或「编辑」二级入口。弹窗的提测记录 tab 要「只列这个项目的提测」，
 * 所以这里用 `loadReleaseList()` 取一次工作区的全部提测，按 `projectId` 分好组再交下去 ——
 * 与提测记录列表同一份数据、同一套状态口径，tab 上的计数不会和点进去看到的行对不上。
 */

import { PageShell } from "@/components/page-shell";
import { listPackages } from "@/lib/packages";
import { listManagers, listProjectCards, listBaselineChoices } from "@/lib/projects";
import { loadReleaseList } from "@/lib/releases";
import { resolveWorkspaceScope, showsWorkspaceSwitcher } from "../workspaceScope";
import { filterProjectsByName } from "./filter";
import { groupReleasesByProject, type PackageChoice } from "./modalModel";
import { ProjectsView } from "./projectsView";

// 项目数据随配置与提测变化，页面不做静态化。
export const dynamic = "force-dynamic";

type ProjectsPageProps = {
  searchParams: Promise<{ workspace?: string; q?: string; notice?: string; error?: string }>;
};

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/projects", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="项目">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const [projects, managers, baselines, packages, releaseList] = await Promise.all([
    listProjectCards(scope.active.id),
    listManagers(scope.active.id),
    listBaselineChoices(),
    listPackages(),
    loadReleaseList({ workspaceId: scope.active.id, tab: "all" }),
  ]);
  const keyword = query.q?.trim() ?? "";
  const visible = filterProjectsByName(projects, keyword);

  // 软件包清单 tab 只用得到这几列：弹窗里逐行画「分支 · 当前版本 · 上次提测」，
  // 整行 Prisma 记录（含时间戳与计数）不必过客户端边界。
  const packageChoices: PackageChoice[] = packages.map((item) => ({
    id: item.id,
    name: item.name,
    repoPath: item.repoPath,
    currentVersion: item.currentVersion,
    defaultBranch: item.defaultBranch,
  }));

  const releasesByProject = groupReleasesByProject(releaseList.rows);

  // 只有一个工作区时不给筛选条传候选项：不渲染下拉，页面上（含传给客户端的 props）
  // 也就不会出现工作区名（MKACG-1017）。
  const showWorkspace = showsWorkspaceSwitcher(scope.workspaces);
  const workspaceChoices = showWorkspace
    ? scope.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.name }))
    : [];

  return (
    <PageShell title="项目">
      <ProjectsView
        workspaceId={scope.active.id}
        workspaceSlug={scope.active.slug}
        workspaces={workspaceChoices}
        showWorkspace={showWorkspace}
        query={scope.query}
        projects={visible}
        totalCount={projects.length}
        keyword={keyword}
        managers={managers}
        baselines={baselines.map((baseline) => ({
          id: baseline.id,
          name: baseline.name,
          state: baseline.state,
          stateLabel: baseline.stateLabel,
        }))}
        packages={packageChoices}
        releasesByProject={releasesByProject}
        initialNotice={query.notice ?? null}
        initialError={query.error ?? null}
      />
    </PageShell>
  );
}
