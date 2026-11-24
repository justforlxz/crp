/**
 * 项目页（MKACG-971 按原型移植模块结构）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目页与 `design.md` §8：
 * `.section-title` 项目经理 → `.manager-grid` 内多个 `.manager-card` →
 * `.section-title` 项目列表 → `.filters` 内 `.search-field` → `.grid.project-grid` 内多个
 * `.project-card`（卡内 `.project-software-chips` 列清单）→ `.tip`。
 *
 * 项目与项目经理都以卡片呈现，不再摊成表格行：卡片的字段全部来自 `listProjectCards()` /
 * `listManagers()` 已有的数据，不为这张页面新增查询字段。搜索只按项目名过滤，条件放查询串里，
 * 刷新、退回都还停在同一个视图。
 */

import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { listManagers, listProjectCards } from "@/lib/projects";
import { ManagerGrid } from "../managers/managerGrid";
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

      <div className="section-title">
        <b>项目经理</b>
        <small>项目创建时必须分配一位项目经理；创建提测时先选择项目经理，再从其负责的项目中选择。</small>
      </div>
      <ManagerGrid managers={managers} />

      <div className="section-title section-gap">
        <b>项目列表</b>
        <small>项目只维护软件包清单和默认跟踪分支；构建依赖从软件包记录读取。</small>
      </div>

      <form method="get" action="/projects" className="filters">
        <input type="hidden" name="workspace" value={scope.active.slug} />

        <div className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            name="q"
            defaultValue={keyword}
            aria-label="搜索项目"
            placeholder="搜索项目名称"
          />
        </div>

        <button type="submit" className="btn primary sm">
          筛选
        </button>
        <Link className="text-link" href={`/projects${scope.query}`}>
          清空条件
        </Link>

        <div className="filter-spacer" />

        <span className="small-note">
          共 {visible.length} 个项目
          {keyword === "" ? null : ` · 关键字「${keyword}」`}
        </span>
      </form>

      <ProjectGrid projects={visible} keyword={keyword} query={scope.query} />

      <div className="tip">
        <div className="tip-icon" aria-hidden="true">
          ⓘ
        </div>
        <div>
          <b>依赖只维护在软件包记录</b>
          <p>
            项目清单里的软件都会参与提测，依赖关系来自软件包记录：清单内的依赖按拓扑顺序提交，
            清单外的依赖不自动加入，也不扩展本次提测范围。
          </p>
        </div>
      </div>
    </PageShell>
  );
}
