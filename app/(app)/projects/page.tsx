/**
 * 项目页（MKACG-971 / MKACG-984 按原型重做）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目页与 `design.md` 第七节：
 *
 *   `.sec-hd` + `.manager-grid` 经理卡 → `.sec-hd`（带 `.search`）+ `.project-grid` 项目卡 → `.tip`
 *
 * 项目与项目经理都以卡片呈现，页面里没有承载这两类数据的 table 元素（FUNC-10）。
 * 卡片的字段全部来自 `listProjectCards()` / `listManagers()` 已有的数据，不为这张页面新增查询字段。
 *
 * 工作区切换放在筛选条里（`.select`）：原型没有额外的切换控件，但一个账号可能属于多个工作区，
 * 这个能力不能丢，收进筛选条比在页面上摊一排链接干净。
 */

import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listManagers, listProjectCards } from "@/lib/projects";
import { ProjectManagerGrid } from "./projectManagerGrid";
import { resolveWorkspaceScope } from "../workspaceScope";
import { filterProjectsByName } from "./filter";
import { ProjectGrid } from "./projectGrid";

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

  const [projects, managers] = await Promise.all([
    listProjectCards(scope.active.id),
    listManagers(scope.active.id),
  ]);
  const keyword = query.q?.trim() ?? "";
  const visible = filterProjectsByName(projects, keyword);

  return (
    <PageShell title="项目">
      <div className="stack">
        <div className="toast-stack">
          <Toast
            className="toast bad"
            role="alert"
            message={query.error === undefined ? null : `操作失败：${query.error}`}
          />
          <Toast
            className="toast ok"
            message={query.notice === undefined ? null : query.notice}
          />
        </div>

        <div>
          <div className="sec-hd">
            <h3>项目经理</h3>
            <span className="hint">创建提测时必须先选一位，再从他负责的项目里选</span>
          </div>
          <ProjectManagerGrid managers={managers} />
        </div>

        <div>
          <div className="sec-hd">
            <h3>项目</h3>
            <span className="hint">一个项目就是一个提测归属单位</span>
            <div className="spacer" />
            <Link className="btn btn-primary" href={`/projects/new${scope.query}`}>
              新建项目
            </Link>
          </div>

          <form method="get" action="/projects" className="filters">
            <label className="search">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                name="q"
                defaultValue={keyword}
                aria-label="搜索项目"
                placeholder="搜索项目名"
                autoComplete="off"
              />
            </label>

            <select
              className="select"
              name="workspace"
              defaultValue={scope.active.slug}
              aria-label="工作区"
            >
              {scope.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>

            <button type="submit" className="btn btn-sm">
              筛选
            </button>
            <Link className="text-link" href={`/projects${scope.query}`}>
              清空条件
            </Link>

            <div className="spacer" />
            <span className="result-n">
              共 {projects.length} 个，显示 {visible.length} 个
            </span>
          </form>

          <ProjectGrid projects={visible} keyword={keyword} query={scope.query} />
        </div>

        <div className="tip">
          <span aria-hidden="true">ⓘ</span>
          <div>
            <b>一个软件包只登记一次。</b>
            依赖关系写在软件包上，项目只做引用。改依赖会影响所有引用该包的项目，改之前先看「引用」列。
          </div>
        </div>
      </div>
    </PageShell>
  );
}
