"use client";

/**
 * 创建提测第 3 步：确认提测（design.md 第八节）。
 *
 * 内容与顺序照原型 `openWizard` 的第 3 步：
 *
 * ```
 * .confirm-card   三组 .cfg-row：项目/经理与 CRP 基线、目标系统仓库与 Topic 版本号、
 *                 固定软件清单与本次提测软件
 * .subhead        「本次提测版本确认」
 * .table-scroll   7 列：提交顺序 / 软件仓库 / 跟踪分支 / 最新 Commit / 代码版本 / CRP 仓库版本 /
 *                 本次提测版本
 * .tip            提测清单已确认的说明
 * ```
 *
 * 只负责显示：顺序、版本与「自定义 Tag」标记都由外壳按服务端算出的结果摆进来，
 * 这一层不再算一遍，也不放按钮（按钮在弹窗底部）。
 */

import { Icon } from "@/components/icons";
import type { ReleaseProjectChoice } from "@/lib/releases";
import { shortSha } from "./wizardTypes";

/** 第三步表格的一行：一个软件包将要写进快照的全部内容。 */
export type ConfirmRow = {
  packageName: string;
  branch: string;
  commitSha: string;
  /** 所选 Commit 的 changelog 版本。 */
  codeVersion: string;
  /** 该基线仓库里当前已有的版本；查不到为 `null`。 */
  repoVersion: string | null;
  /** 本次提测版本（自定义 Tag 或代码版本）。 */
  releaseVersion: string;
  /** 提测版本来自自定义 Tag 而不是代码版本。 */
  custom: boolean;
  /** Commit 与上次提测不同。 */
  changed: boolean;
};

export type StepConfirmProps = {
  project: ReleaseProjectChoice;
  /** CRP 提测版本号（Topic 的版本号）。 */
  version: string;
  /** 按投递顺序排好的行。 */
  rows: readonly ConfirmRow[];
  /** 清单里的仓库总数，与 `rows.length` 区分：没有读到的包不进表格。 */
  packageCount: number;
};

export function StepConfirm({ project, version, rows, packageCount }: StepConfirmProps) {
  const changedCount = rows.filter((row) => row.changed).length;

  return (
    <>
      <div className="confirm-card" data-style-anchor="release-new.confirm-card">
        <div className="cfg-row">
          <div>
            <small>所属项目 / 项目经理</small>
            <b>
              {project.name} · {project.managerName}
            </b>
          </div>
          <div>
            <small>CRP 目标基线</small>
            <b className="num">{project.baseline.name}</b>
          </div>
        </div>
        <div className="cfg-row">
          <div>
            <small>目标系统仓库</small>
            <b>{project.baseline.description ?? project.baseline.name}</b>
          </div>
          <div>
            <small>CRP Topic 版本号</small>
            <b className="num">{version}</b>
          </div>
        </div>
        <div className="cfg-row">
          <div>
            <small>项目固定软件清单</small>
            <b>{packageCount} 个仓库</b>
          </div>
          <div>
            <small>本次提测软件</small>
            <b>
              {rows.length} 个（{changedCount} 个有更新 / {rows.length - changedCount} 个无变化）
            </b>
          </div>
        </div>
      </div>

      <div className="subhead">本次提测版本确认</div>

      <div className="table-scroll">
        <table className="grid cols-confirm">
          <thead>
            <tr>
              <th className="num">提交顺序</th>
              <th>软件仓库</th>
              <th>跟踪分支</th>
              <th>最新 Commit</th>
              <th className="num">代码版本</th>
              <th className="num">CRP 仓库版本</th>
              <th>本次提测版本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.packageName}>
                <td className="num">
                  <strong>{index + 1}</strong>
                </td>
                <td>
                  <strong>{row.packageName}</strong>
                </td>
                <td className="col-mono">{row.branch}</td>
                <td>
                  <span className="col-mono">{shortSha(row.commitSha)}</span>
                  <span className="cell-sub">{row.changed ? "与上次提测不同" : "与上次提测相同"}</span>
                </td>
                <td className="num col-mono">{row.codeVersion}</td>
                <td className="num col-mono">{row.repoVersion ?? "—"}</td>
                <td>
                  <b className="num text-accent">{row.releaseVersion}</b>
                  <span className="cell-sub">{row.custom ? "自定义 Tag" : "默认版本"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="tip" data-style-anchor="release-new.confirm-tip">
        <Icon name="check" />
        <div>
          <b>提测清单已确认</b>
          项目预设中的全部软件都会提交；更新状态只作提示，不决定是否纳入。不会自动补齐或加入依赖
          软件。每个软件的分支、Commit、changelog 代码版本、CRP 仓库当前版本和本次提测版本都会
          固化到提测快照。
        </div>
      </div>
    </>
  );
}
