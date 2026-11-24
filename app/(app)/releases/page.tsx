/**
 * 提测记录列表（A13，MKACG-964 按原型移植模块）。
 *
 * 三件事：按状态页签看、按项目与工作区筛、按编号 / 版本 / Topic 搜。每行标出来源（平台创建 /
 * 从 CRP 导入），点进去是详情页，右侧可以导出这一条的快照表。
 *
 * 结构与 class 名来自 `.agents/spec/design/prototype.html` 的提测记录页：
 * `.page-tabs`、`.filters` + `.field` + `.search-field` + `.filter-spacer`、`.card table-card` +
 * `.table-scroll` + `.table-footer`、`.empty`、`.primary-cell` / `.secondary` / `.mono` / `.pill`。
 *
 * 原型的表头有 8 列，其中「CRP 基线」不在 `ReleaseListRow` 里，取它要改列表查询（超出本单
 * 「不改数据查询」的边界），所以这一列省略，其余列的单元格结构照原型。
 *
 * 页签的归并规则、标签、条数统计都在 `lib/releases/list.ts`，这个页面只负责摆位置。
 * 筛选全在查询串里，刷新、收藏、退回都还停在同一个视图。
 */
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import {
  loadReleaseList,
  loadReleaseProjectOptions,
  parseStatusTab,
  RELEASE_STATUS_TABS,
  RELEASE_TAB_LABELS,
  releaseSourceLabel,
  releaseStatusLabel,
  releaseStatusPillClass,
  type ReleaseStatusTab,
} from "@/lib/releases";
import { resolveWorkspaceScope } from "../workspaceScope";

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

type ListFilters = {
  workspace: string;
  status: ReleaseStatusTab;
  project: string;
  q: string;
};

function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** 当前筛选拼成链接；切换页签或翻筛选都不丢掉其余条件。 */
function listHref(filters: ListFilters, patch: Partial<ListFilters> = {}): string {
  const merged = { ...filters, ...patch };
  const params = new URLSearchParams();

  if (merged.workspace !== "") {
    params.set("workspace", merged.workspace);
  }

  if (merged.status !== "all") {
    params.set("status", merged.status);
  }

  if (merged.project !== "") {
    params.set("project", merged.project);
  }

  if (merged.q !== "") {
    params.set("q", merged.q);
  }

  const query = params.toString();

  return query === "" ? "/releases" : `/releases?${query}`;
}

export default async function ReleasesPage({ searchParams }: ReleasesPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/releases", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="提测记录">
        <div className="card panel">
          <div className="empty">
            这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
            {scope.account.displayName}
          </div>
        </div>
      </PageShell>
    );
  }

  const filters: ListFilters = {
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

  return (
    <PageShell
      title="提测记录"
      actions={
        <>
          <Link
            className="btn"
            href={`/releases/import${scope.query}`}
            data-style-anchor="releases.create-actions"
          >
            从 CRP 导入
          </Link>
          <Link className="btn primary" href={`/releases/new${scope.query}`}>
            ＋ 创建提测
          </Link>
        </>
      }
    >
      <p data-style-anchor="releases.intro">
        一次提测对应 CRP 的一个 Topic。列表里能按状态、项目与关键字找，点进详情能看这次提测固化了
        哪些软件包的哪个 Commit；快照只追加不改写，唯一的变更入口是详情页的「更新提测」。
      </p>

      <div className="page-tabs" data-style-anchor="releases.status-tabs">
        {RELEASE_STATUS_TABS.map((tab) => (
          <Link
            key={tab}
            className={tab === filters.status ? "active" : undefined}
            href={listHref(filters, { status: tab })}
            aria-current={tab === filters.status ? "page" : undefined}
          >
            {RELEASE_TAB_LABELS[tab]}（{list.counts[tab]}）
          </Link>
        ))}
      </div>

      <form method="get" action="/releases" className="filters" data-style-anchor="releases.filters">
        <input type="hidden" name="status" value={filters.status} />

        <label htmlFor="release-workspace-filter" className="small-note">
          工作区
        </label>
        <select
          id="release-workspace-filter"
          className="field"
          name="workspace"
          defaultValue={filters.workspace}
        >
          {scope.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.slug}>
              {workspace.name}
            </option>
          ))}
        </select>

        <label htmlFor="release-project-filter" className="small-note">
          项目
        </label>
        <select
          id="release-project-filter"
          className="field"
          name="project"
          defaultValue={filters.project}
        >
          <option value="">全部项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}（{project.key}）
            </option>
          ))}
        </select>

        <div className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            id="release-keyword"
            type="search"
            name="q"
            defaultValue={filters.q}
            aria-label="搜索提测记录"
            placeholder="提测版本、项目标识或 CRP Topic 编号"
          />
        </div>

        <button type="submit" className="btn primary sm">
          筛选
        </button>
        <Link className="text-link" href={listHref(filters, { project: "", q: "", status: "all" })}>
          清空条件
        </Link>

        <div className="filter-spacer" />

        <span className="small-note" data-style-anchor="releases.count">
          共 {list.rows.length} 条记录
          {filters.status === "all" ? null : ` · 页签：${RELEASE_TAB_LABELS[filters.status]}`}
          {filters.q === "" ? null : ` · 关键字「${filters.q}」`}
        </span>
      </form>

      <div className="card table-card" data-style-anchor="releases.table">
        <div className="table-wrap table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>提测记录 / CRP Topic</th>
                <th>所属项目</th>
                <th>轮次</th>
                <th>软件包</th>
                <th>状态</th>
                <th>创建人 / 时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="primary-cell">
                      <Link href={`/releases/${row.id}${scope.query}`} className="mono">
                        {row.version}
                      </Link>
                    </div>
                    <div className="secondary">
                      {row.crpTopicId === null ? "未关联 Topic" : row.crpTopicId} ·{" "}
                      {releaseSourceLabel(row.source)}
                    </div>
                  </td>
                  <td>
                    {row.projectName}
                    <div className="secondary mono">{row.projectKey}</div>
                  </td>
                  <td>第 {row.revision} 轮</td>
                  <td>{row.packageCount} 个软件包</td>
                  <td data-style-anchor="releases.row-status">
                    <span className={releaseStatusPillClass(row.status)}>{releaseStatusLabel(row.status)}</span>
                  </td>
                  <td>
                    {row.createdByName}
                    <div className="secondary">{formatTime(row.createdAt)}</div>
                  </td>
                  <td>
                    <Link className="btn sm" href={`/releases/${row.id}${scope.query}`}>
                      查看
                    </Link>
                    {" "}
                    <a className="text-link" href={`/api/releases/${row.id}/export`}>
                      导出
                    </a>
                  </td>
                </tr>
              ))}
              {list.rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty" data-style-anchor="releases.empty">
                      这个条件下的提测记录是空的。
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>显示 {list.rows.length} 条记录</span>
          <span>快照只追加不改写 · 变更入口在详情页的「更新提测」</span>
        </div>
      </div>
    </PageShell>
  );
}
