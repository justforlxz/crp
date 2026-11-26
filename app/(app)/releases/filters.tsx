"use client";

/**
 * 提测记录页的筛选条（界面规范 v2 第七节 `.filters`）。
 *
 * 为什么是客户端组件：design.md 第九节要求「搜索输入即过滤」，服务端表单要点一次按钮才走，
 * 不算即时。这里每次输入/切换都把条件写回网址（`router.replace`），页面仍是服务端渲染的
 * 那一份数据与计数 —— 过滤只有一套实现，不在浏览器里再算一遍。
 *
 * 四个控件与原型一致：
 *
 * - `.search`：搜索提测版本、项目名或项目标识；
 * - `.select` × 2：工作区、项目；
 * - `.result-n`：`共 N 条，显示 M 条`；
 * - 右侧「导出」：把当前这几行导成 CSV。
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Icon } from "@/components/icons";
import { buildReleaseListCsv, type ReleaseListCsvRow } from "./listCsv";

export type FilterOption = { value: string; label: string };

export type ReleaseFiltersProps = {
  /** 工作区下拉的候选项。 */
  workspaces: FilterOption[];
  /** 是否渲染工作区下拉：账号属于两个以上工作区时才出现（MKACG-1017）。 */
  showWorkspace: boolean;
  /** 项目下拉的候选项；第一个是「全部项目」。 */
  projects: FilterOption[];
  /** 当前条件，来自网址。 */
  workspace: string;
  project: string;
  keyword: string;
  /** 当前页签，切条件时原样带上。 */
  status: string;
  /** 当前条件下总条数与当前页签的条数，用来写 `.result-n`。 */
  total: number;
  shown: number;
  /** 当前视图的行，导出用。 */
  rows: readonly ReleaseListCsvRow[];
};

/** 文件名：带工作区与日期，导到下载目录里能分清是哪次导的。 */
function csvFilename(): string {
  const stamp = new Date().toISOString().slice(0, 10);

  return `提测记录-${stamp}.csv`;
}

export function ReleaseFilters({
  workspaces,
  showWorkspace,
  projects,
  workspace,
  project,
  keyword,
  status,
  total,
  shown,
  rows,
}: ReleaseFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  /** 改一个查询参数并刷新页面数据；空值就从网址里删掉，链接保持干净。 */
  function setParam(key: string, value: string): void {
    const params = new URLSearchParams(searchParams.toString());

    if (value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }

    const query = params.toString();

    startTransition(() => {
      router.replace(query === "" ? "/releases" : `/releases?${query}`, { scroll: false });
    });
  }

  /** 导出当前视图：在浏览器里拼好 CSV 再下载，不新增接口。 */
  function exportCsv(): void {
    const blob = new Blob([buildReleaseListCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = csvFilename();
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="filters" data-style-anchor="releases.filters">
      <label className="search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="搜索提测记录"
          placeholder="搜索版本、项目或创建人"
          autoComplete="off"
          value={keyword}
          disabled={pending}
          onChange={(event) => setParam("q", event.target.value)}
        />
      </label>

      {showWorkspace ? (
        <select
          className="select"
          aria-label="工作区"
          value={workspace}
          disabled={pending}
          onChange={(event) => setParam("workspace", event.target.value)}
        >
          {workspaces.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}

      <select
        className="select"
        aria-label="项目"
        value={project}
        disabled={pending}
        onChange={(event) => setParam("project", event.target.value)}
      >
        {projects.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <span className="result-n num" data-style-anchor="releases.count">
        共 {total} 条，显示 {shown} 条
      </span>

      <div className="spacer" />

      <button type="button" className="btn" onClick={exportCsv} disabled={rows.length === 0}>
        <Icon name="download" />
        导出
      </button>

      {/* 页签切换要保留当前筛选条件，这里把它挂成一个隐藏字段供无障碍工具读到。 */}
      <input type="hidden" name="status" value={status} readOnly />
    </div>
  );
}
