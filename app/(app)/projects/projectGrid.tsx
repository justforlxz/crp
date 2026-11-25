/**
 * 项目卡片网格（MKACG-971 / MKACG-984 按原型重做）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页：
 *
 *   `.project-grid` → `.project-card`
 *     内依次是 `.pc-hd`（`.pc-ico` + `.pc-title` 里的 `.pc-name` / `.pc-key`）
 *     → `.pc-body`（`.pc-facts` 三项事实 + `.pc-chips` 软件胶囊）
 *     → `.pc-ft`（基线状态点 + 右侧「发起提测」）。
 *
 * 软件包按拓扑顺序用 `.chip` 列出，超过 6 个折成「还有 N 个」（界面用例 FUNC-11）。
 * 依赖环在胶囊里点名，空清单写「尚未添加软件包」—— 卡片只表达清单构成，不摊成表格行。
 *
 * 项目说明不在卡片上（原型没有这一块），完整说明在项目详情页。
 */

import Link from "next/link";

import { formatCycle } from "@/lib/packages/dependencyGraph";
import type { ProjectCard as ProjectCardData } from "@/lib/projects";

/** 卡片上最多摆几个软件包胶囊，超出的折成「还有 N 个」，与原型和 FUNC-11 一致。 */
const CHIP_LIMIT = 6;

type ProjectGridProps = {
  projects: readonly ProjectCardData[];
  /** 当前的搜索关键字，只用于空态文案。 */
  keyword: string;
  /** 带当前工作区的查询串，卡片里的链接不丢工作区。 */
  query: string;
};

export function ProjectGrid({ projects, keyword, query }: ProjectGridProps) {
  if (projects.length === 0) {
    return (
      <div className="empty">
        <div className="empty-ico" aria-hidden="true">◇</div>
        <div className="empty-t">
          {keyword === "" ? "这个工作区还没有项目" : `没有名称含「${keyword}」的项目`}
        </div>
        <div className="empty-d">
          {keyword === "" ? "先新建一个项目，再把软件包挂上去。" : "换个关键词试试。"}
        </div>
        <Link className="btn btn-sm" href={keyword === "" ? `/projects/new${query}` : `/projects${query}`}>
          {keyword === "" ? "新建项目" : "清除筛选"}
        </Link>
      </div>
    );
  }

  return (
    <div className="project-grid">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} query={query} />
      ))}
    </div>
  );
}

function ProjectCard({ project, query }: { project: ProjectCardData; query: string }) {
  const href = `/projects/${project.id}${query}`;
  const hidden = project.software.entries.length - CHIP_LIMIT;

  return (
    <div className="project-card">
      <div className="pc-hd">
        <div className="pc-ico" aria-hidden="true">
          {project.name.slice(0, 1)}
        </div>
        <div className="pc-title">
          <div className="pc-name">
            <Link href={href}>{project.name}</Link>
          </div>
          <div className="pc-key">{project.key}</div>
        </div>
        <Link className="btn btn-sm" href={href} aria-label="编辑项目">
          编辑
        </Link>
      </div>

      <div className="pc-body">
        <dl className="pc-facts">
          <div className="pc-fact">
            <dt>项目经理</dt>
            <dd>{project.manager.name}</dd>
          </div>
          <div className="pc-fact">
            <dt>软件包</dt>
            <dd className="num">{project.software.count}</dd>
          </div>
          <div className="pc-fact">
            <dt>依赖</dt>
            <dd className="num">{project.software.dependencyCount}</dd>
          </div>
        </dl>

        <div className="pc-chips">
          {project.software.entries.slice(0, CHIP_LIMIT).map((entry, index) => (
            <span className="chip" key={entry.packageName}>
              <i>{index + 1}</i>
              {entry.packageName}
            </span>
          ))}
          {hidden > 0 ? (
            <span className="chip">
              <i>还有 {hidden} 个</i>
            </span>
          ) : null}
          {project.software.entries.length === 0 ? (
            <span className="chip">
              <i>尚未添加软件包</i>
            </span>
          ) : null}
          {project.software.cycle === null ? null : (
            <span className="chip">
              <i>有环：{formatCycle(project.software.cycle)}</i>
            </span>
          )}
        </div>
      </div>

      <div className="pc-ft">
        <span className="dot is-wait">
          基线 {project.baseline.name}
          {project.baseline.syncedAt === null ? "（未同步）" : null}
        </span>
        <div className="spacer" />
        <Link className="btn btn-sm" href={`/releases/new${query}`}>
          发起提测
        </Link>
      </div>
    </div>
  );
}
