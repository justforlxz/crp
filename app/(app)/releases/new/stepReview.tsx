"use client";

/**
 * 创建提测第 2 步：检查仓库更新（design.md 第八节）。
 *
 * 内容与顺序照原型 `openWizard` 的第 2 步：
 *
 * ```
 * .target-banner     提测目标（项目 / 基线）+ 项目预设仓库数
 * .update-overview   Gerrit 代码状态：说明 + 三档统计（关注仓库 / 检测到更新 / 无变化）+ 刷新
 * .wiz-toolbar       项目软件清单说明 + 筛选（全部 / 仅有更新 / 仅无变化）+ 搜索
 * .wiz-table         7 列：提交顺序 / 软件仓库 / 本次分支 / 本次 Commit（含代码版本）/ CRP 仓库版本 /
 *                    本次提测版本 / 更新状态
 * .wiz-foot-note     表尾统计
 * .wiz-helper        自定义版本的说明
 * ```
 *
 * 四条语义在这一层看得见（design.md 第八节）：
 *
 * 1. **没有勾选框**：全部项目软件都会提测，用户不能挑；
 * 2. **提交顺序不是用户排的**：顺序来自依赖，所以只有序号，没有拖动、没有调序按钮；
 * 3. **更新状态只是提示**：「无变化」的包照样留在清单里；
 * 4. **每行可切分支、选历史 Commit、设自定义版本号**：三者都在单元格里就地完成。
 *
 * Gerrit 读不到分支或提交时，下拉禁用并在单元格里写原因（design.md 第八节「Gerrit 下拉的禁用规则」），
 * 不填任何占位或猜测值。
 */

import { Icon } from "@/components/icons";
import type { GerritCommitOption, ReleaseBlocker, ReleaseProjectChoice } from "@/lib/releases";
import { shortSha, type Selection, type WizardFilter } from "./wizardTypes";

/** 第二步表格的一行。提测版本与「有没有更新」在外壳里按快照规则算好。 */
export type ReviewRow = {
  packageName: string;
  repoPath: string;
  /** 依赖顺序里的位次，从 1 开始。 */
  order: number;
  branches: string[];
  commits: GerritCommitOption[];
  /** 当前的选择；还没选中为 `null`。 */
  selection: Selection | null;
  /** 该基线仓库里当前已有的版本；查不到为 `null`。 */
  repoVersion: string | null;
  /** 提测版本；`selection` 为 `null` 时也是 `null`。 */
  releaseVersion: string | null;
  /** Commit 与上次提测不同；`selection` 为 `null` 时也是 `null`。 */
  changed: boolean | null;
  /** 自定义 Tag 的格式问题；没填或合法为 `null`。 */
  tagError: string | null;
  /** 这一行的分支或提交正在读。 */
  busy: boolean;
  /** Gerrit 读不到这一行的原因；能读到就是 `null`。有值时下拉禁用并把原因写出来。 */
  unavailable: string | null;
};

export type StepReviewProps = {
  project: ReleaseProjectChoice;
  refreshing: boolean;
  /** 是否已经读到过仓库数据。 */
  loaded: boolean;
  /** 筛选与搜索之后要显示的行。 */
  rows: readonly ReviewRow[];
  /** 清单里的全部仓库数（不受筛选影响）。 */
  allCount: number;
  /** 检测到更新的仓库数（不受筛选影响）。 */
  changedCount: number;
  filter: WizardFilter;
  query: string;
  /** 正在行内编辑自定义版本号的包名；没有就是 `null`。 */
  editing: string | null;
  /** 行内输入框里的草稿值。 */
  tagDraft: string;
  blockers: readonly ReleaseBlocker[];
  warnings: ReadonlyArray<{ packageName: string; warning: string }>;
  errors: ReadonlyArray<{ packageName: string; error: string }>;
  onRefresh: () => void;
  onFilterChange: (filter: WizardFilter) => void;
  onQueryChange: (query: string) => void;
  onBranchChange: (packageName: string, branch: string) => void;
  onCommitChange: (packageName: string, commitSha: string) => void;
  onTagEdit: (packageName: string, currentTag: string) => void;
  onTagDraftChange: (draft: string) => void;
  onTagSave: (packageName: string) => void;
  onTagReset: (packageName: string) => void;
  onTagCancel: () => void;
};

/** 一行的分支下拉。读不到分支时禁用，并把原因写进唯一那个选项。 */
function BranchCell({ row, onBranchChange }: { row: ReviewRow; onBranchChange: StepReviewProps["onBranchChange"] }) {
  if (row.branches.length === 0) {
    return (
      <>
        <select className="select select-sm" disabled aria-label={`${row.packageName} 本次分支`}>
          <option value="">（读不到分支）</option>
        </select>
        <span className="cell-sub">{row.unavailable ?? "Gerrit 没有返回可用分支"}</span>
      </>
    );
  }

  return (
    <select
      className="select select-sm"
      value={row.selection?.branch ?? ""}
      disabled={row.busy}
      aria-label={`${row.packageName} 本次分支`}
      onChange={(event) => onBranchChange(row.packageName, event.target.value)}
    >
      {row.selection === null ? <option value="">请选择分支</option> : null}
      {row.branches.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  );
}

/** 一行的提交下拉，下面跟着所选提交的代码版本。 */
function CommitCell({ row, onCommitChange }: { row: ReviewRow; onCommitChange: StepReviewProps["onCommitChange"] }) {
  if (row.commits.length === 0) {
    return (
      <>
        <select className="select select-sm" disabled aria-label={`${row.packageName} 本次 Commit`}>
          <option value="">（读不到提交）</option>
        </select>
        <span className="cell-sub">{row.unavailable ?? "Gerrit 没有返回提交"}</span>
      </>
    );
  }

  return (
    <>
      <select
        className="select select-sm"
        value={row.selection?.commitSha ?? ""}
        disabled={row.busy}
        aria-label={`${row.packageName} 本次 Commit`}
        onChange={(event) => onCommitChange(row.packageName, event.target.value)}
      >
        {row.selection === null ? <option value="">请选择 Commit</option> : null}
        {row.commits.map((commit) => (
          <option key={commit.sha} value={commit.sha}>
            {shortSha(commit.sha)} · {commit.summary}
          </option>
        ))}
      </select>
      <span className="cell-sub">
        代码版本 {row.selection?.codeVersion ?? "—"} ·{" "}
        {row.commits.find((commit) => commit.sha === row.selection?.commitSha)?.time ?? "—"}
      </span>
    </>
  );
}

/** 一行的「本次提测版本」：默认显示算出来的版本，点「自定义版本号」就地展开输入框。 */
function ReleaseVersionCell({
  row,
  editing,
  tagDraft,
  onTagEdit,
  onTagDraftChange,
  onTagSave,
  onTagReset,
  onTagCancel,
}: {
  row: ReviewRow;
  editing: string | null;
  tagDraft: string;
  onTagEdit: StepReviewProps["onTagEdit"];
  onTagDraftChange: StepReviewProps["onTagDraftChange"];
  onTagSave: StepReviewProps["onTagSave"];
  onTagReset: StepReviewProps["onTagReset"];
  onTagCancel: StepReviewProps["onTagCancel"];
}) {
  const tagged = row.selection !== null && row.selection.customTag.trim() !== "";

  if (editing === row.packageName) {
    return (
      <>
        <input
          className="input input-sm"
          value={tagDraft}
          aria-label={`${row.packageName} 自定义提测版本号`}
          placeholder={row.selection?.codeVersion ?? "留空用代码版本"}
          onChange={(event) => onTagDraftChange(event.target.value)}
        />
        <div className="tag-actions">
          <button type="button" className="text-link" onClick={() => onTagSave(row.packageName)}>
            保存
          </button>
          <button type="button" className="text-link" onClick={() => onTagReset(row.packageName)}>
            恢复默认
          </button>
          <button type="button" className="text-link" onClick={onTagCancel}>
            取消
          </button>
        </div>
        {row.tagError === null ? null : (
          <span className="cell-sub" role="alert">
            {row.tagError}
          </span>
        )}
      </>
    );
  }

  return (
    <>
      <b className="num text-accent">{row.releaseVersion ?? "—"}</b>
      <button
        type="button"
        className="text-link"
        onClick={() => onTagEdit(row.packageName, row.selection?.customTag ?? "")}
      >
        {tagged ? "修改自定义版本" : "自定义版本号"}
      </button>
      {tagged ? <span className="cell-sub">自定义 Tag</span> : null}
    </>
  );
}

export function StepReview({
  project,
  refreshing,
  loaded,
  rows,
  allCount,
  changedCount,
  filter,
  query,
  editing,
  tagDraft,
  blockers,
  warnings,
  errors,
  onRefresh,
  onFilterChange,
  onQueryChange,
  onBranchChange,
  onCommitChange,
  onTagEdit,
  onTagDraftChange,
  onTagSave,
  onTagReset,
  onTagCancel,
}: StepReviewProps) {
  const unchangedCount = allCount - changedCount;

  return (
    <>
      <div className="target-banner">
        <div>
          <small>提测目标</small>
          <b>
            {project.name}　/　{project.baseline.name}
          </b>
          <span>
            {project.baseline.description ?? project.baseline.name} · 项目经理 {project.managerName}
          </span>
        </div>
        <span className="chip">项目预设 {allCount} 个仓库</span>
      </div>

      <div className="update-overview">
        <div className="uo-main">
          <b>Gerrit 代码状态</b>
          <span>
            默认使用项目配置的跟踪分支和 Gerrit 最新 Commit；每个软件都可以单独切换分支、选择历史
            Commit。代码版本从所选 Commit 的 debian/changelog 读取。
          </span>
        </div>
        <div className="kpis">
          <div>
            <b className="num">{allCount}</b>
            <small>关注仓库</small>
          </div>
          <div className="has">
            <b className="num">{changedCount}</b>
            <small>检测到更新</small>
          </div>
          <div>
            <b className="num">{unchangedCount}</b>
            <small>无变化</small>
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={refreshing}>
          <Icon name="refresh" />
          {refreshing ? "正在刷新…" : "刷新代码状态"}
        </button>
      </div>

      <div className="wiz-toolbar">
        <div>
          <b>项目软件清单</b>
          <span>全部项目软件都会提测，并按软件包记录中的依赖关系确定 CRP 提交顺序。</span>
        </div>
        <div className="toolbar-actions">
          <select
            className="select"
            aria-label="按更新状态筛选"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value as WizardFilter)}
          >
            <option value="all">全部软件</option>
            <option value="yes">仅有更新</option>
            <option value="no">仅无变化</option>
          </select>
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="搜索软件包或 Commit"
              placeholder="搜索软件包 / Commit"
              autoComplete="off"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
        </div>
      </div>

      {loaded ? (
        <div className="table-scroll wiz-table">
          <table className="grid cols-wizard">
            <thead>
              <tr>
                <th className="num">提交顺序</th>
                <th>软件仓库</th>
                <th>本次分支</th>
                <th>本次 Commit / 代码版本</th>
                <th className="num">CRP 仓库版本</th>
                <th>本次提测版本</th>
                <th>更新状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.packageName}>
                  <td className="num">
                    <strong>{row.order}</strong>
                  </td>
                  <td>
                    <strong>{row.packageName}</strong>
                    <span className="cell-sub col-mono">{row.repoPath}</span>
                  </td>
                  <td>
                    <BranchCell row={row} onBranchChange={onBranchChange} />
                  </td>
                  <td>
                    <CommitCell row={row} onCommitChange={onCommitChange} />
                  </td>
                  <td className="num col-mono">{row.repoVersion ?? "—"}</td>
                  <td>
                    <ReleaseVersionCell
                      row={row}
                      editing={editing}
                      tagDraft={tagDraft}
                      onTagEdit={onTagEdit}
                      onTagDraftChange={onTagDraftChange}
                      onTagSave={onTagSave}
                      onTagReset={onTagReset}
                      onTagCancel={onTagCancel}
                    />
                  </td>
                  <td>
                    {row.changed === null ? (
                      <span className="dot is-wait">未知</span>
                    ) : row.changed ? (
                      <span className="dot is-warn">有更新</span>
                    ) : (
                      <span className="dot is-wait">无变化</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      <div className="empty-ico" aria-hidden="true">
                        <Icon name="empty" />
                      </div>
                      <div className="empty-t">没有符合这个条件的软件</div>
                      <div className="empty-d">换个关键词，或把筛选切回「全部软件」。</div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wiz-helper">{refreshing ? "正在读取分支与提交…" : "还没有读取仓库数据。"}</p>
      )}

      <div className="wiz-foot-note">
        <span>
          本次将提测 <b>{allCount}</b> 个项目软件；Gerrit 检测到 <b>{changedCount}</b> 个有更新、
          <b>{unchangedCount}</b> 个无变化。
        </span>
        <span>代码版本取自所选 Commit 的 debian/changelog</span>
      </div>

      <div className="wiz-helper">
        本次提测版本默认填写所选 Commit 中检测到的 changelog 版本。即使更新状态为「无变化」，
        软件包也会保留在提测清单中；如需不同版本，可单独设置自定义 Tag。
      </div>

      {blockers.length > 0 ? (
        <div className="risk" role="alert" data-style-anchor="release-new.review-blockers">
          <Icon name="alert" />
          <div>
            <b>提交被阻断</b>
            <ul>
              {blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="risk" role="alert" data-style-anchor="release-new.review-errors">
          <Icon name="alert" />
          <div>
            <b>这些软件包读不到仓库数据</b>
            <ul>
              {errors.map((item) => (
                <li key={item.packageName}>
                  {item.packageName}：{item.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="tip" role="status" data-style-anchor="release-new.review-warnings">
          <Icon name="info" />
          <div>
            <b>这些软件包的数据可用，但需要看一眼</b>
            <ul>
              {warnings.map((item) => (
                <li key={item.packageName}>
                  {item.packageName}：{item.warning}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
