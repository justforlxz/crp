import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { formatCycle } from "@/lib/packages";
import { listProjectCards } from "@/lib/projects";
import { resolveWorkspaceScope } from "../workspaceScope";

// 项目数据随配置与提测变化，页面不做静态化。
export const dynamic = "force-dynamic";

type ProjectsPageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

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

  const projects = await listProjectCards(scope.active.id);

  return (
    <PageShell title="项目">
      <p>
        一个项目就是一个提测归属单位：固定一位项目经理、一个 CRP 基线、一份软件清单。
        依赖只在软件包上维护，项目里不重复配置。
      </p>

      <p>
        工作区：
        {scope.workspaces.map((workspace) => (
          <span key={workspace.id}>
            <Link href={`/projects?workspace=${encodeURIComponent(workspace.slug)}`}>
              {workspace.name}
            </Link>
            {workspace.id === scope.active?.id ? "（当前）" : null}{" "}
          </span>
        ))}
      </p>

      <p>
        <Link href={`/projects/new${scope.query}`}>新建项目</Link>
        {"　"}
        <Link href={`/managers${scope.query}`}>项目经理</Link>
      </p>

      {query.error === undefined ? null : (
        <p className="alert alert--error" role="alert">
          操作失败：{query.error}
        </p>
      )}
      {query.notice === undefined ? null : (
        <p className="alert alert--info" role="status">
          {query.notice}
        </p>
      )}

      {projects.length === 0 ? (
        <p className="empty">这个工作区还没有项目。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>标识</th>
                <th>项目经理</th>
                <th>CRP 基线</th>
                <th>软件数</th>
                <th>依赖数</th>
                <th>拓扑排序结果（上游在前）</th>
                <th>依赖环</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/projects/${project.id}${scope.query}`}>{project.name}</Link>
                  </td>
                  <td>
                    <code>{project.key}</code>
                  </td>
                  <td>{project.manager.name}</td>
                  <td>
                    <code>{project.baseline.name}</code>
                    {project.baseline.syncedAt === null ? "（未同步）" : null}
                  </td>
                  <td>{project.software.count}</td>
                  <td>{project.software.dependencyCount}</td>
                  <td>
                    <code>
                      {project.software.order.length === 0
                        ? "（清单为空）"
                        : project.software.order.join(" → ")}
                    </code>
                  </td>
                  <td>
                    {project.software.cycle === null
                      ? "无"
                      : `有环：${formatCycle(project.software.cycle)}`}
                  </td>
                  <td>{formatTime(project.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
