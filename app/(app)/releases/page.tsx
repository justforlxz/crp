/**
 * 提测记录列表（A13）。
 *
 * 三件事：按状态页签看、按项目与工作区筛、按编号 / 版本 / Topic 搜。每行标出来源（平台创建 /
 * 从 CRP 导入），点进去是详情页，右侧可以导出这一条的快照表。
 *
 * 页签的归并规则、标签、条数统计都在 `lib/releases/list.ts`，这个页面只负责摆位置。
 * 筛选全在查询串里，刷新、收藏、退回都还停在同一个视图；页签之间的数字与点进去看到的行
 * 出自同一次统计，不会出现「显示 3 条、点开 0 条」。
 */
import Link from "next/link";

import {
  loadReleaseList,
  loadReleaseProjectOptions,
  parseStatusTab,
  RELEASE_STATUS_TABS,
  RELEASE_TAB_LABELS,
  releaseSourceLabel,
  releaseStatusLabel,
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
      <main>
        <h1>提测记录</h1>
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </main>
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
    <main>
      <h1>提测记录</h1>
      <p>
        一次提测对应 CRP 的一个 Topic。列表里能按状态、项目与关键字找，点进详情能看这次提测固化了
        哪些软件包的哪个 Commit；快照只追加不改写，唯一的变更入口是详情页的「更新提测」。
      </p>

      <p>
        工作区：
        {scope.workspaces.map((workspace) => (
          <span key={workspace.id}>
            <Link href={listHref(filters, { workspace: workspace.slug, project: "" })}>
              {workspace.name}
            </Link>
            {workspace.id === scope.active?.id ? "（当前）" : null}{" "}
          </span>
        ))}
      </p>

      <p>
        状态页签：
        {RELEASE_STATUS_TABS.map((tab) => (
          <span key={tab}>
            {tab === filters.status ? (
              <strong>
                {RELEASE_TAB_LABELS[tab]}（{list.counts[tab]}）
              </strong>
            ) : (
              <Link href={listHref(filters, { status: tab })}>
                {RELEASE_TAB_LABELS[tab]}（{list.counts[tab]}）
              </Link>
            )}{" "}
          </span>
        ))}
      </p>

      <form method="get" action="/releases">
        <input type="hidden" name="workspace" value={filters.workspace} />
        <input type="hidden" name="status" value={filters.status} />
        <label htmlFor="release-project-filter">项目</label>
        <select id="release-project-filter" name="project" defaultValue={filters.project}>
          <option value="">全部项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}（{project.key}）
            </option>
          ))}
        </select>
        <label htmlFor="release-keyword">搜索</label>
        <input
          id="release-keyword"
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="提测版本、项目标识或 CRP Topic 编号"
        />
        <button type="submit">筛选</button>
        <Link href={listHref(filters, { project: "", q: "", status: "all" })}>清空条件</Link>
      </form>

      <p>
        共 {list.rows.length} 条
        {filters.status === "all" ? null : `（页签：${RELEASE_TAB_LABELS[filters.status]}）`}
        {filters.q === "" ? null : `，关键字「${filters.q}」`}
        。
      </p>

      {list.rows.length === 0 ? (
        <p>这个条件下的提测记录是空的。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>提测版本</th>
              <th>轮次</th>
              <th>状态</th>
              <th>来源</th>
              <th>软件数</th>
              <th>创建人</th>
              <th>CRP Topic</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.projectName}（<code>{row.projectKey}</code>）
                </td>
                <td>
                  <Link href={`/releases/${row.id}${scope.query}`}>
                    <code>{row.version}</code>
                  </Link>
                </td>
                <td>第 {row.revision} 轮</td>
                <td>{releaseStatusLabel(row.status)}</td>
                <td>{releaseSourceLabel(row.source)}</td>
                <td>{row.packageCount}</td>
                <td>{row.createdByName}</td>
                <td>{row.crpTopicId === null ? "—" : <code>{row.crpTopicId}</code>}</td>
                <td>{formatTime(row.createdAt)}</td>
                <td>
                  <Link href={`/releases/${row.id}${scope.query}`}>详情</Link>
                  {"　"}
                  <a href={`/api/releases/${row.id}/export`}>导出 CSV</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <Link href={`/releases/new${scope.query}`}>创建提测</Link>
        {"　"}
        <Link href={`/releases/import${scope.query}`}>从 CRP 导入</Link>
        {"　"}
        <Link href={`/projects${scope.query}`}>项目</Link>
      </p>
    </main>
  );
}
