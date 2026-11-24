"use client";

/**
 * 创建提测第 1 步：项目归属（design.md 第八节）。
 *
 * 内容与顺序照原型 `openWizard` 的第 1 步：
 *
 * ```
 * .wiz-note          说明：先选经理，再选他负责的项目
 * .form-row2         项目经理下拉 / 所属项目下拉（跟随经理联动）
 * .baseline-summary  5 格：目标系统仓库 / 项目 CRP 基线 / 基线同步状态 / 项目固定软件 / 项目经理
 * .form-row2         CRP 提测版本号 / 项目类型（只读）
 * .field             提测说明（.textarea）
 * ```
 *
 * 只负责显示与收集输入：状态留在向导外壳（`wizard.tsx`），阻断结论由服务端算好传进来。
 * 按钮在弹窗底部（`.modal-ft`），由外壳按当前步骤给出，这一层不放按钮。
 */

import { Icon } from "@/components/icons";
import type { ReleaseProjectChoice } from "@/lib/releases";
import { baselineTone } from "./wizardTypes";

export type StepProjectProps = {
  /** 项目经理的去重清单：`[id, 显示名]`。 */
  managers: Array<[string, string]>;
  /** 当前选中的项目经理名下的项目。 */
  managerProjects: ReleaseProjectChoice[];
  managerId: string;
  projectId: string;
  version: string;
  description: string;
  /** 当前选中的项目；没选为 `null`。 */
  project: ReleaseProjectChoice | null;
  onManagerChange: (managerId: string) => void;
  onProjectChange: (projectId: string) => void;
  onVersionChange: (version: string) => void;
  onDescriptionChange: (description: string) => void;
};

export function StepProject({
  managers,
  managerProjects,
  managerId,
  projectId,
  version,
  description,
  project,
  onManagerChange,
  onProjectChange,
  onVersionChange,
  onDescriptionChange,
}: StepProjectProps) {
  return (
    <>
      <div className="wiz-note">
        <b>先选择项目经理，再选择该经理负责的项目</b>
        <span>
          项目已固定配置 CRP 基线和软件清单。选定项目后，系统会据此确定本次需要提测的软件包及其
          CRP 提交顺序。
        </span>
      </div>

      <div className="form-row2">
        <label className="field">
          <span className="label">项目经理 *</span>
          <select
            id="wizard-manager"
            className="select"
            data-style-anchor="release-new.manager-select"
            value={managerId}
            onChange={(event) => onManagerChange(event.target.value)}
          >
            <option value="">请选择项目经理</option>
            {managers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">所属项目 *</span>
          <select
            id="wizard-project"
            className="select"
            data-style-anchor="release-new.project-select"
            value={projectId}
            disabled={managerId === ""}
            onChange={(event) => onProjectChange(event.target.value)}
          >
            <option value="">{managerId === "" ? "先选项目经理" : "请选择项目"}</option>
            {managerProjects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{item.key}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="baseline-summary" data-style-anchor="release-new.baseline-summary">
        <div>
          <small>目标系统仓库</small>
          <b>{project === null ? "未配置" : (project.baseline.description ?? project.baseline.name)}</b>
        </div>
        <div>
          <small>项目 CRP 基线</small>
          <b className="num">{project === null ? "未配置" : project.baseline.name}</b>
        </div>
        <div>
          <small>基线同步状态</small>
          <b>
            {project === null ? (
              "未配置"
            ) : (
              <span className={`dot ${baselineTone(project.baseline.state)}`}>
                {project.baseline.stateLabel}
              </span>
            )}
          </b>
        </div>
        <div>
          <small>项目固定软件</small>
          <b>{project === null ? "—" : `${project.packageCount} 个仓库`}</b>
        </div>
        <div>
          <small>项目经理</small>
          <b>{project === null ? "—" : project.managerName}</b>
        </div>
      </div>

      <div className="form-row2">
        <label className="field">
          <span className="label">CRP 提测版本号</span>
          <input
            id="wizard-version"
            className="input"
            value={version}
            onChange={(event) => onVersionChange(event.target.value)}
            placeholder="25.0.2"
          />
          <span className="note">Topic 版本号，与各软件的代码版本独立。</span>
        </label>

        <label className="field">
          <span className="label">项目类型</span>
          <input className="input" value="—" disabled readOnly />
          <span className="note">项目配置里还没有类型字段。</span>
        </label>
      </div>

      <label className="field">
        <span className="label">提测说明</span>
        <textarea
          id="wizard-memo"
          className="textarea"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="填写本次提测的变更范围和验证重点"
        />
      </label>

      {project === null || project.blockers.length === 0 ? null : (
        <div className="risk" role="alert" data-style-anchor="release-new.blockers">
          <Icon name="alert" />
          <div>
            <b>这个项目现在不能提测</b>
            <ul>
              {project.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
