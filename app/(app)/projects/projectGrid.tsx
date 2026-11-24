/**
 * 项目卡片网格（MKACG-971）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页：`.grid` 里一列列 `.project-card`，
 * 卡内是「类型图标 + 名称 + 标识 → 项目经理 → 三项 meta → 软件包 chips → 说明 + 标签」。
 * `.project-software-chips` 用胶囊按拓扑顺序列出清单里的软件包，超出的折成「+N」，
 * 与原型一样只在卡片里表达清单构成，不再把项目摊成表格行。
 *
 * 空清单与依赖环都在这一层说清楚：前者写「尚未添加软件包」，后者用红色 pill 点名环上的包 ——
 * 环上的顺序不是可投递顺序，必须让看的人先看到。
 */

import Link from "next/link";

import { formatCycle } from "@/lib/packages/dependencyGraph";
import type { ProjectCard as ProjectCardData } from "@/lib/projects";

/** 卡片上最多摆几个软件包胶囊，超出的折成「+N」，与原型一致。 */
const CHIP_LIMIT = 7;

/** 时间一律按 UTC 显示并标出来，避免读者把本地时间当成更新时间。 */
function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

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
      <p className="empty">
        {keyword === "" ? "这个工作区还没有项目。" : `没有名称含「${keyword}」的项目。`}
      </p>
    );
  }

  return (
    <div className="grid project-grid">
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
    <div className="card project-card">
      <div className="project-card-top">
        <div className="project-icon" aria-hidden="true">
          {project.name.slice(0, 1)}
        </div>
        <div>
          <h3>
            <Link href={href}>{project.name}</Link>
          </h3>
          <p>
            <code>{project.key}</code>
          </p>
        </div>
        <div className="project-actions">
          <Link className="icon-btn" href={href} aria-label="编辑项目" title="编辑项目">
            ✎
          </Link>
        </div>
      </div>

      <div className="manager">
        项目经理：<b>{project.manager.name}</b>
      </div>

      <div className="project-meta">
        <span>
          CRP 基线
          <b className="mono">
            {project.baseline.name}
            {project.baseline.syncedAt === null ? "（未同步）" : null}
          </b>
        </span>
        <span>
          软件包<b>{project.software.count} 个</b>
        </span>
        <span>
          依赖关系<b>{project.software.dependencyCount} 条</b>
        </span>
      </div>

      <div className="project-software-summary">
        <div className="project-software-summary-head">
          <b>项目软件包清单</b>
          <Link className="text-link" href={href}>
            管理清单 →
          </Link>
        </div>
        <div className="project-software-chips">
          {project.software.entries.slice(0, CHIP_LIMIT).map((entry, index) => (
            <span key={entry.packageName}>
              <i>{index + 1}</i>
              {entry.packageName}
              <small>
                {entry.upstreamNames.length === 0 ? "无依赖" : `依赖 ${entry.upstreamNames.length} 项`}
              </small>
            </span>
          ))}
          {hidden > 0 ? <span className="more-chip">+{hidden}</span> : null}
          {project.software.entries.length === 0 ? (
            <span className="small-note">尚未添加软件包</span>
          ) : null}
          {project.software.cycle === null ? null : (
            <span className="pill p-red">有环：{formatCycle(project.software.cycle)}</span>
          )}
        </div>
      </div>

      <div className="project-card-foot">
        <span className="small-note">{project.description ?? "还没有项目说明。"}</span>
        <span className="tag">更新于 {formatTime(project.updatedAt)}</span>
      </div>
    </div>
  );
}
