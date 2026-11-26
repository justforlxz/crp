/**
 * 提测记录列表：按状态看、按项目与工作区筛、按版本 / 项目 / 创建人搜。
 *
 * 结构与类名照 `.agents/spec/design/prototype.html` 的提测记录页：
 *
 * ```
 * .panel
 *   .tabs      五个页签，每个带 .tab-n 计数
 *   .filters   .search + .select × 2 + .result-n + 导出
 *   .table-scroll > table.grid
 *   .empty     没有符合条件的行时出现，带「清除筛选」
 * ```
 *
 * 页签的归并规则、标签、条数统计都在 `lib/releases/list.ts`；筛选与搜索由 `./filters.tsx`
 * 写回网址后由这一页重新查一遍，所以「页签上的数字」与「点进去看到的行」永远出自同一次查询。
 */
import Link from "next/link";

import { Icon } from "@/components/icons";
import { PageShell } from "@/components/page-shell";
import {
  loadReleaseList,
  loadReleaseProjectOptions,
  parseStatusTab,
  RELEASE_STATUS_TABS,
  RELEASE_TAB_LABELS,
  releaseSourceLabel,
  releaseStatusLabel,
  releaseStatusTone,
  type ReleaseStatusTab,
} from "@/lib/releases";
import { resolveWorkspaceScope, showsWorkspaceSwitcher } from "../workspaceScope";
import { ReleaseFilters, type FilterOption } from "./filters";
import type { ReleaseListCsvRow } from "./listCsv";

// 提测状态一直在变，页面不做静态化。
export const dynamic = "force-dynamic";

type ReleasesPageProps = {
  searchParams: Promise<{
    workspace?: string;
    status?: string;
    project?: string;
    q?: string;
  }>;
};

/** 页签切换只改状态，其余筛选条件原样带着走。 */
function tabHref(
  filters: { workspace: string; project: string; q: string },
  status: ReleaseStatusTab,
): string {
  const params = new URLSearchParams();

  params.set("workspace", filters.workspace);

  if (status !== "all") {
    params.set("status", status);
  }

  if (filters.project !== "") {
    params.set("project", filters.project);
  }

  if (filters.q !== "") {
    params.set("q", filters.q);
  }

  return `/releases?${params.toString()}`;
}

/** 表格与导出文件共用的时间写法：按 UTC 到分钟。 */
function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export default async function ReleasesPage({ searchParams }: ReleasesPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/releases", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="提测记录" description="按状态、项目与关键字查看">
        <div className="panel">
          <div className="panel-bd">
            <div className="empty">
              <div className="empty-ico" aria-hidden="true">
                <Icon name="empty" />
              </div>
              <div className="empty-t">还没有加入任何工作区</div>
              <div className="empty-d">
                先请平台管理员把账号加入工作区。当前登录：{scope.account.displayName}
              </div>
            </div>
          </div>
        </div>
      </PageShell>
    );
  }

  const filters = {
    workspace: scope.active.slug,
    status: parseStatusTab(query.status),
    project: query.project?.trim() ?? "",
    q: query.q?.trim() ?? "",
  };

  const [list, projects] = await Promise.all([
    loadReleaseList({
      workspaceId: scope.active.id,
      tab: filters.status,
      projectId: filters.project === "" ? null : filters.project,
      keyword: filters.q,
    }),
    loadReleaseProjectOptions(scope.active.id),
  ]);

  // 只有一个工作区时不给筛选条传候选项：不渲染下拉，页面上（含传给客户端的 props）
  // 也就不会出现工作区名（MKACG-1017）。
  const showWorkspace = showsWorkspaceSwitcher(scope.workspaces);
  const workspaceOptions: FilterOption[] = showWorkspace
    ? scope.workspaces.map((workspace) => ({
        value: workspace.slug,
        label: workspace.name,
      }))
    : [];
  const projectOptions: FilterOption[] = [
    { value: "", label: "全部项目" },
    ...projects.map((project) => ({ value: project.id, label: `${project.name}（${project.key}）` })),
  ];

  // 导出用的行与表格里的行一一对应，就在下面同一个 map 里拼出来。
  const csvRows: ReleaseListCsvRow[] = list.rows.map((row) => ({
    version: row.version,
    projectName: row.projectName,
    projectKey: row.projectKey,
    revision: row.revision,
    packageCount: row.packageCount,
    statusLabel: releaseStatusLabel(row.status),
    createdByName: row.createdByName,
    createdAt: formatTime(row.createdAt),
  }));

  const clearHref = tabHref({ workspace: filters.workspace, project: "", q: "" }, "all");

  return (
    <PageShell
      title="提测记录"
      description={`共 ${String(list.counts.all)} 条，${String(list.counts.failed)} 条需要处理`}
      actions={
        <>
          <Link
            className="btn"
            href={`/releases/import${scope.query}`}
            data-style-anchor="releases.create-actions"
          >
            从 CRP 导入
          </Link>
          <Link className="btn btn-primary" href={`/releases/new${scope.query}`}>
            <Icon name="plus" />
            创建提测
          </Link>
        </>
      }
    >
      <div className="panel" data-style-anchor="releases.table">
        <div
          className="tabs"
          role="tablist"
          aria-label="按状态筛选"
          data-style-anchor="releases.status-tabs"
        >
          {RELEASE_STATUS_TABS.map((tab) => (
            <Link
              key={tab}
              className="tab"
              role="tab"
              href={tabHref(filters, tab)}
              aria-selected={tab === filters.status}
            >
              {RELEASE_TAB_LABELS[tab]}
              <span className="tab-n num">{list.counts[tab]}</span>
            </Link>
          ))}
        </div>

        <ReleaseFilters
          workspaces={workspaceOptions}
          showWorkspace={showWorkspace}
          projects={projectOptions}
          workspace={filters.workspace}
          project={filters.project}
          keyword={filters.q}
          status={filters.status}
          total={list.counts.all}
          shown={list.rows.length}
          rows={csvRows}
        />

        <div className="table-scroll">
          <table className="grid cols-releases">
            <thead>
              <tr>
                <th>提测记录</th>
                <th>所属项目</th>
                <th className="num">轮次</th>
                <th className="num">软件包</th>
                <th>状态</th>
                <th>创建人</th>
                <th className="num">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/releases/${row.id}${scope.query}`}>
                      <strong>{row.version}</strong>
                    </Link>
                    <span className="cell-sub">
                      {row.crpTopicId === null ? "未关联 Topic" : row.crpTopicId} ·{" "}
                      {releaseSourceLabel(row.source)}
                    </span>
                  </td>
                  <td>
                    {row.projectName}
                    <span className="cell-sub col-mono">{row.projectKey}</span>
                  </td>
                  <td className="num">第 {row.revision} 轮</td>
                  <td className="num">{row.packageCount} 个</td>
                  <td>
                    <span
                      className={`dot ${releaseStatusTone(row.status)}`}
                      data-style-anchor="releases.row-status"
                    >
                      {releaseStatusLabel(row.status)}
                    </span>
                  </td>
                  <td>{row.createdByName}</td>
                  <td className="num">{formatTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {list.rows.length === 0 ? (
            <div className="empty" data-style-anchor="releases.empty">
              <div className="empty-ico" aria-hidden="true">
                <Icon name="empty" />
              </div>
              <div className="empty-t">没有符合条件的提测</div>
              <div className="empty-d">换个关键词，或切到「全部」看看。</div>
              <Link className="btn btn-sm" href={clearHref}>
                清除筛选
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
