"use client";

/**
 * 项目卡片网格（MKACG-971 / MKACG-984 按原型重做，MKACG-1010 改成「点卡片开弹窗」）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页：
 *
 *   `.project-grid` → `.project-card`
 *     内依次是 `.pc-hd`（`.pc-ico` + `.pc-title` 里的 `.pc-name` / `.pc-key`）
 *     → `.pc-body`（`.pc-facts` 三项事实 + `.pc-chips` 软件胶囊）
 *     → `.pc-ft`（基线状态点 + 右侧「发起提测」）。
 *
 * **整张卡就是入口**（MKACG-1010）：原型把卡写成 `data-act="project:edit:<key>"`，这里换成
 * 卡上的点击与 Enter / 空格 —— 原型取消了「...」二级菜单，全部操作收进弹窗的四个 tab，
 * 卡上只剩「发起提测」一个独立动作，它要挡住冒泡，否则点它会连带把弹窗也开出来。
 *
 * 软件包按拓扑顺序用 `.chip` 列出，超过 6 个折成「还有 N 个」（界面用例 FUNC-11）。
 * 依赖环在胶囊里点名，空清单写「尚未添加软件包」—— 卡片只表达清单构成，不摊成表格行。
 *
 * 项目说明不在卡片上（原型没有这一块），完整说明在项目弹窗的基本信息 tab。
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
  /** 点卡片：打开这个项目的编辑弹窗。 */
  onOpen: (project: ProjectCardData) => void;
  /** 空态里的新建动作：与卡片同一个弹窗。 */
  onCreate: () => void;
};

export function ProjectGrid({ projects, keyword, query, onOpen, onCreate }: ProjectGridProps) {
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
        {keyword === "" ? (
          <button type="button" className="btn btn-sm" onClick={onCreate}>
            新建项目
          </button>
        ) : (
          <Link className="btn btn-sm" href={`/projects${query}`}>
            清除筛选
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="project-grid">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          query={query}
          onOpen={() => onOpen(project)}
        />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  query,
  onOpen,
}: {
  project: ProjectCardData;
  query: string;
  onOpen: () => void;
}) {
  const hidden = project.software.entries.length - CHIP_LIMIT;

  return (
    <div
      className="project-card"
      role="button"
      tabIndex={0}
      aria-label={`编辑项目 ${project.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        // 只认落在卡片本身上的按键。卡里的「发起提测」链接收到回车时，keydown 会冒泡到这里；
        // 若在这里 preventDefault 并开弹窗，键盘用户就再也用不了那个链接（鼠标点击带
        // stopPropagation，自动化点击测不出来）。判断写法与 `components/modal.tsx` 的遮罩一致。
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="pc-hd">
        <div className="pc-ico" aria-hidden="true">
          {project.name.slice(0, 1)}
        </div>
        <div className="pc-title">
          <div className="pc-name">{project.name}</div>
          <div className="pc-key">{project.key}</div>
        </div>
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
        <Link
          className="btn btn-sm"
          href={`/releases/new${query}`}
          onClick={(event) => {
            // 卡上的第二个动作：不挡住冒泡就会连编辑弹窗一起打开。
            event.stopPropagation();
          }}
        >
          发起提测
        </Link>
      </div>
    </div>
  );
}
