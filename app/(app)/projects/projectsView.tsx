"use client";

/**
 * 项目页的交互外壳（MKACG-1010）：把「项目卡 → 四 tab 弹窗」这件事包成一层客户端状态，
 * 服务端那一侧（`page.tsx`）只负责取数。
 *
 * 为什么整层搬到客户端：点卡片开弹窗、切 tab、把填了一半的草稿留住，都是纯客户端行为，
 * 走一次服务端往返会把弹窗和草稿一起清掉。写库仍然走服务端动作（`actions.ts` 的 `apply*`），
 * 成功后用 `router.refresh()` 让服务端重新取数 —— 卡片当场更新，弹窗还开着。
 *
 * 页面的结构（`.sec-hd` / `.manager-grid` / `.filters` / `.project-grid` / `.tip`）与类名照
 * `.agents/spec/design/prototype.html` 的项目页，这里只把它们串起来，不改任何一层。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Toast } from "@/components/toast";
import type { ProjectCard } from "@/lib/projects";

import type { ManagerCardData } from "../managers/managerGrid";
import { ProjectManagerGrid } from "./projectManagerGrid";
import { ProjectGrid } from "./projectGrid";
import { ProjectModal } from "./projectModal";
import type { BaselineChoice, PackageChoice, ProjectRelease } from "./modalModel";

export type ProjectsViewProps = {
  workspaceId: string;
  /** 当前工作区的 slug，筛选条里的下拉默认选它。 */
  workspaceSlug: string;
  /** 这个账号能进的工作区，写在筛选条的下拉里。 */
  workspaces: readonly { slug: string; name: string }[];
  /** 是否渲染工作区下拉：账号属于两个以上工作区时才出现（MKACG-1017）。 */
  showWorkspace: boolean;
  /** 带当前工作区的查询串，链接与「清空条件」都用它。 */
  query: string;
  /** 工作区里的全部项目（已按搜索结果过滤过）。 */
  projects: readonly ProjectCard[];
  /** 过滤前的项目总数，写在筛选条右侧。 */
  totalCount: number;
  keyword: string;
  managers: readonly ManagerCardData[];
  baselines: readonly BaselineChoice[];
  packages: readonly PackageChoice[];
  /** 提测记录按项目分好组：弹窗的提测记录 tab 与它的计数都从这里来。 */
  releasesByProject: Record<string, readonly ProjectRelease[]>;
  /** 页面地址里带回来的提示（跳转族动作留下的），进来就能看到。 */
  initialNotice: string | null;
  initialError: string | null;
};

/** 弹窗当前编辑的对象：`"new"` 是新建，其余是项目 id。 */
type OpenTarget = "new" | string | null;

export function ProjectsView({
  workspaceId,
  workspaceSlug,
  workspaces,
  showWorkspace,
  query,
  projects,
  totalCount,
  keyword,
  managers,
  baselines,
  packages,
  releasesByProject,
  initialNotice,
  initialError,
}: ProjectsViewProps) {
  const router = useRouter();
  const [open, setOpen] = useState<OpenTarget>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [error, setError] = useState<string | null>(initialError);

  // 打开的项目按 id 现查，不存整张卡：写库后 `router.refresh()` 换掉了 props，
  // 存了快照就会在弹窗里看到过期的软件清单。
  const openProject =
    open === null || open === "new"
      ? null
      : (projects.find((project) => project.id === open) ?? null);
  const modalOpen = open === "new" || openProject !== null;

  function closeModal(): void {
    setOpen(null);
  }

  function refresh(): void {
    router.refresh();
  }

  return (
    <>
      <div className="stack">
        <div className="toast-stack">
          <Toast
            className="toast bad"
            role="alert"
            message={error}
          />
          <Toast className="toast ok" message={notice} />
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
            <span className="hint">一个项目就是一个提测归属单位，点卡片编辑</span>
            <div className="spacer" />
            <button type="button" className="btn btn-primary" onClick={() => setOpen("new")}>
              新建项目
            </button>
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

            {showWorkspace ? (
              <select
                className="select"
                name="workspace"
                defaultValue={workspaceSlug}
                aria-label="工作区"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.slug} value={workspace.slug}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            ) : null}

            <button type="submit" className="btn btn-sm">
              筛选
            </button>
            <Link className="text-link" href={`/projects${query}`}>
              清空条件
            </Link>

            <div className="spacer" />
            <span className="result-n">
              共 {totalCount} 个，显示 {projects.length} 个
            </span>
          </form>

          <ProjectGrid
            projects={projects}
            keyword={keyword}
            query={query}
            onOpen={(project) => setOpen(project.id)}
            onCreate={() => setOpen("new")}
          />
        </div>

        <div className="tip">
          <span aria-hidden="true">ⓘ</span>
          <div>
            <b>一个软件包只登记一次。</b>
            依赖关系写在软件包上，项目只做引用。改依赖会影响所有引用该包的项目，改之前先看「引用」列。
          </div>
        </div>
      </div>

      {modalOpen ? (
        <ProjectModal
          key={open === "new" ? "new" : (openProject?.id ?? "none")}
          project={openProject}
          workspaceId={workspaceId}
          query={query}
          managers={managers}
          baselines={baselines}
          packages={packages}
          releases={openProject === null ? [] : (releasesByProject[openProject.id] ?? [])}
          onClose={closeModal}
          onNotice={setNotice}
          onError={setError}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}
