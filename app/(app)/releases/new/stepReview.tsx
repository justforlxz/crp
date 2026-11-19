"use client";

/**
 * 创建提测的第二步：从 Gerrit 读出每个软件包的分支与提交，逐包选分支、选 Commit、填自定义 Tag。
 *
 * 只负责显示与转发操作：分支、提交、代码版本都由服务端动作现取，这里不拼 Gerrit 请求；
 * 阻断结论与「有没有更新」由向导外壳按服务端算出的 `readiness` 传进来。
 *
 * 宽表的每一列都很窄，七列在窄屏上放不开，表格外面套一层横向滚动容器，
 * 溢出留在表格自己身上，不让整页出现横向滚动条。
 */

import type { GerritCommitOption, ReleaseBlocker } from "@/lib/releases";
import { styles } from "../../../styles";
import { shortSha, type Selection } from "./wizardTypes";

/** 第二步表格的一行。提测版本与「有没有更新」在外壳里按快照规则算好。 */
export type ReviewRow = {
  packageName: string;
  repoPath: string;
  /** 该基线仓库里当前已有的版本；查不到为 `null`。 */
  repoVersion: string | null;
  branches: string[];
  commits: GerritCommitOption[];
  /** 当前的选择；还没选中为 `null`。 */
  selection: Selection | null;
  /** 提测版本；`selection` 为 `null` 时也是 `null`。 */
  releaseVersion: string | null;
  /** Commit 与上次提测不同；`selection` 为 `null` 时也是 `null`。 */
  changed: boolean | null;
  /** 自定义 Tag 的格式问题；没填或合法为 `null`。 */
  tagError: string | null;
  /** 这一行的分支或提交正在读。 */
  busy: boolean;
};

export type StepReviewProps = {
  refreshing: boolean;
  /** 是否已经读到过仓库数据；没读过时表格不显示。 */
  loaded: boolean;
  /** 服务端算出的投递顺序；还没读到时为 `null`。 */
  order: string[] | null;
  blockers: ReleaseBlocker[];
  rows: ReviewRow[];
  packageCount: number;
  changedCount: number;
  warnings: Array<{ packageName: string; warning: string }>;
  errors: Array<{ packageName: string; error: string }>;
  /** 能不能进第三步。 */
  canGoNext: boolean;
  onRefresh: () => void;
  onBranchChange: (packageName: string, branch: string) => void;
  onCommitChange: (packageName: string, commitSha: string) => void;
  onTagChange: (packageName: string, customTag: string) => void;
  onBack: () => void;
  onNext: () => void;
};

export function StepReview({
  refreshing,
  loaded,
  order,
  blockers,
  rows,
  packageCount,
  changedCount,
  warnings,
  errors,
  canGoNext,
  onRefresh,
  onBranchChange,
  onCommitChange,
  onTagChange,
  onBack,
  onNext,
}: StepReviewProps) {
  return (
    <>
      <h2>第二步：检查仓库更新</h2>
      <p>
        <button type="button" style={styles.smallButton} onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "正在从 Gerrit 刷新…" : "从 Gerrit 刷新"}
        </button>
        {order === null ? null : (
          <>
            {" "}
            <code>{order.join(" → ")}</code>
          </>
        )}
      </p>

      {blockers.length > 0 ? (
        <div role="alert">
          <p>提交被阻断：</p>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {loaded ? (
        <div style={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>软件包</th>
                <th>分支</th>
                <th>Commit</th>
                <th>代码版本</th>
                <th>仓库版本</th>
                <th>提测版本（自定义 Tag）</th>
                <th>对比上次</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.packageName}>
                  <td>
                    {row.packageName}
                    <br />
                    <small>{row.repoPath}</small>
                  </td>
                  <td>
                    <select
                      style={styles.input}
                      value={row.selection?.branch ?? ""}
                      onChange={(event) => onBranchChange(row.packageName, event.target.value)}
                      disabled={row.busy || row.branches.length === 0}
                    >
                      {row.branches.length === 0 ? <option value="">（读不到分支）</option> : null}
                      {row.branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      style={styles.input}
                      value={row.selection?.commitSha ?? ""}
                      onChange={(event) => onCommitChange(row.packageName, event.target.value)}
                      disabled={row.busy || row.commits.length === 0}
                    >
                      {row.commits.length === 0 ? <option value="">（读不到提交）</option> : null}
                      {row.commits.map((commit) => (
                        <option key={commit.sha} value={commit.sha}>
                          {shortSha(commit.sha)} {commit.summary}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{row.selection?.codeVersion ?? "—"}</td>
                  <td>{row.repoVersion ?? "—"}</td>
                  <td>
                    <input
                      style={styles.input}
                      value={row.selection?.customTag ?? ""}
                      onChange={(event) => onTagChange(row.packageName, event.target.value)}
                      placeholder={row.selection?.codeVersion ?? "留空用代码版本"}
                    />
                    <small>提测版本：{row.releaseVersion ?? "—"}</small>
                    {row.tagError === null ? null : <small role="alert"> {row.tagError}</small>}
                  </td>
                  <td>
                    {row.changed === null ? "—" : row.changed ? "有更新" : "无变化"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{refreshing ? "正在读取分支与提交…" : "还没有读取仓库数据。"}</p>
      )}

      {warnings.length > 0 ? (
        <div role="status">
          <p>这些软件包的数据可用，但需要看一眼：</p>
          <ul>
            {warnings.map((item) => (
              <li key={item.packageName}>
                {item.packageName}：{item.warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div role="alert">
          <p>这些软件包读不到仓库数据：</p>
          <ul>
            {errors.map((item) => (
              <li key={item.packageName}>
                {item.packageName}：{item.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loaded ? (
        <p role="status">
          本次将提测 {packageCount} 个软件，其中 {changedCount} 个有更新。
          「无变化」的软件包同样会进提测。
        </p>
      ) : null}

      <p>
        <button type="button" style={styles.smallButton} onClick={onBack}>
          上一步
        </button>{" "}
        <button type="button" style={styles.button} onClick={onNext} disabled={!canGoNext}>
          下一步：确认
        </button>
      </p>
    </>
  );
}
