"use client";

/**
 * 创建提测的第三步：按服务端算出的投递顺序把要固化的内容再摆一遍，确认后提交。
 *
 * 只负责显示与两个按钮：提交走 `POST /api/releases`，服务端会再把阻断条件与清单一致性判一次。
 * 表格外面套横向滚动容器，理由与第二步相同。
 */

import { shortSha } from "./wizardTypes";

/** 第三步表格的一行：一个软件包将要写进快照的全部内容。 */
export type ConfirmRow = {
  packageName: string;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  changed: boolean;
};

export type StepConfirmProps = {
  rows: ConfirmRow[];
  submitting: boolean;
  /** 能不能提交：阻断条件、缺选择、Tag 格式、读不到仓库数据、版本号为空，任一成立都不行。 */
  canSubmit: boolean;
  onBack: () => void;
  onSubmit: () => void;
};

export function StepConfirm({ rows, submitting, canSubmit, onBack, onSubmit }: StepConfirmProps) {
  return (
    <>
      <h2>第三步：确认提交</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>软件包</th>
              <th>分支</th>
              <th>Commit</th>
              <th>代码版本</th>
              <th>仓库版本</th>
              <th>提测版本</th>
              <th>对比上次</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.packageName}>
                <td>{row.packageName}</td>
                <td>
                  <code>{row.branch}</code>
                </td>
                <td>
                  <code>{shortSha(row.commitSha)}</code>
                </td>
                <td>{row.codeVersion}</td>
                <td>{row.repoVersion ?? "—"}</td>
                <td>{row.releaseVersion}</td>
                <td>{row.changed ? "有更新" : "无变化"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        提交后状态为 <code>pending</code>（已创建、尚未投递），投递由 A12 按上面的顺序进行。
      </p>

      <p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
          上一步
        </button>{" "}
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={!canSubmit}>
          {submitting ? "提交中…" : "提交提测"}
        </button>
      </p>
    </>
  );
}
