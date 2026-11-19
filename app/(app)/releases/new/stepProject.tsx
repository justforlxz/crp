"use client";

/**
 * 创建提测的第一步：选项目经理与项目、填 Topic 版本号与提测说明。
 *
 * 只负责显示与收集输入：状态留在向导外壳（`wizard.tsx`），阻断结论由服务端算好传进来。
 * 进了第二步、第三步之后这一块仍然显示，只是输入框变为不可编辑 —— 与拆开之前一致。
 */

import type { ReleaseProjectChoice } from "@/lib/releases";

export type StepProjectProps = {
  /** 是否停在第一步：只有停在这一步时输入框可编辑。 */
  active: boolean;
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
  onNext: () => void;
};

export function StepProject({
  active,
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
  onNext,
}: StepProjectProps) {
  return (
    <>
      <h2 data-style-anchor="release-new.step-project">第一步：项目归属</h2>

      <p>
        <label className="field-label" htmlFor="release-manager">
          项目经理
        </label>
        <select
          id="release-manager"
          data-style-anchor="release-new.manager-select"
          className="input"
          value={managerId}
          onChange={(event) => onManagerChange(event.target.value)}
          disabled={!active}
        >
          <option value="">请选择项目经理</option>
          {managers.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </p>

      <p>
        <label className="field-label" htmlFor="release-project">
          项目
        </label>
        <select
          id="release-project"
          data-style-anchor="release-new.project-select"
          className="input"
          value={projectId}
          onChange={(event) => onProjectChange(event.target.value)}
          disabled={!active || managerId === ""}
        >
          <option value="">请选择项目</option>
          {managerProjects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}（{item.key}）
            </option>
          ))}
        </select>
      </p>

      {project === null ? null : (
        <dl>
          <dt>目标仓库（CRP 基线）</dt>
          <dd>
            <code>{project.baseline.name}</code>（{project.baseline.stateLabel}）
          </dd>
          <dt>软件数</dt>
          <dd>
            {project.packageCount} 个，清单内部依赖 {project.dependencyCount} 条
          </dd>
          <dt>投递顺序（上游在前）</dt>
          <dd>
            <code>{project.order.length === 0 ? "（清单为空）" : project.order.join(" → ")}</code>
          </dd>
        </dl>
      )}

      {project !== null && project.blockers.length > 0 ? (
        <div className="alert alert--error" role="alert" data-style-anchor="release-new.blockers">
          <p>这个项目现在不能提测：</p>
          <ul>
            {project.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p>
        <label className="field-label" htmlFor="release-version">
          Topic 版本号
        </label>
        <input
          id="release-version"
          className="input"
          value={version}
          onChange={(event) => onVersionChange(event.target.value)}
          placeholder="25.0.2"
          disabled={!active}
        />{" "}
        同一项目内唯一，重复会被拒绝。
      </p>

      <p>
        <label className="field-label" htmlFor="release-description">
          提测说明（可不填）
        </label>
        <input
          id="release-description"
          className="input"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          disabled={!active}
        />
      </p>

      {active ? (
        <p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNext}
            disabled={projectId === "" || version.trim() === ""}
          >
            下一步：检查仓库更新
          </button>
        </p>
      ) : null}
    </>
  );
}
