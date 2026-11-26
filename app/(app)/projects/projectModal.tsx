"use client";

/**
 * 项目弹窗（MKACG-1010）：点项目卡直接打开的宽版四 tab 弹窗，取代原来的「编辑」二级入口。
 *
 * 结构与类名照 `.agents/spec/design/prototype.html` 的 `drawProjectModal()`：
 *
 * ```
 * .modal.is-wide
 *   .modal-hd   项目名 / 「新建项目」+ .modal-sub（项目标识）+ ×
 *   .tabs       基本信息 / 软件包清单（计数）/ 提测记录（计数）/ 危险操作
 *   .modal-bd   当前 tab 的内容
 *   .modal-ft   取消 + 保存（危险操作 tab 只有「关闭」，新建时是取消 + 创建项目）
 * ```
 *
 * 三条原型里写明、也最容易做丢的行为：
 *
 * 1. **切 tab 不丢输入。** 基本信息的四个输入全程受控于 `draft`，切走时值已经在草稿里，
 *    切回来原样显示；草稿只在点「保存」时写库（design.md 第九节：草稿态不写库）。
 * 2. **软件包清单只决定提测哪些包。** 顺序由依赖算，用户不能排；加包先取软件包的默认分支，
 *    与提测向导一致（design.md 第八节第一条）。
 * 3. **删除单独一页 + 二次确认。** 危险操作 tab 先讲清「只删平台配置，不动 CRP」，
 *    点「删除这个项目」再弹一层确认，确认后才写库。
 *
 * 写库动作走 `actions.ts` 的 `apply*`：它们只返回一句话结果，不跳转 —— 跳转会把这个弹窗
 * 连同草稿一起清掉。成功后由 `onChanged` 让页面重新取数（`router.refresh()`），卡片与
 * 清单当场更新。
 *
 * 不加动画、不加内联样式；图标靠 `.btn svg` / `.tip svg` / `.risk svg` / `.empty-ico svg`
 * 已有的尺寸规则（design.md 4.3），不在这里写 style。
 */

import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Modal, ModalScrim } from "@/components/modal";
import { releaseStatusLabel, releaseStatusTone } from "@/lib/releases/labels";

import {
  applyAddSoftware,
  applyCreateProject,
  applyDeleteProject,
  applyRemoveSoftware,
  applyUpdateProject,
} from "./actions";
import {
  baselineChoicesFor,
  editDraft,
  initialModalState,
  projectTabs,
  switchTab,
  type BasicDraft,
  type BaselineChoice,
  type ManagerChoice,
  type ModalState,
  type PackageChoice,
  type ProjectRelease,
} from "./modalModel";

export type ProjectModalProps = {
  /** 弹窗要编辑的项目；`null` 表示新建。 */
  project: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    manager: { id: string; name: string };
    baseline: { id: string; name: string };
    software: {
      count: number;
      entries: readonly {
        packageName: string;
        trackedBranch: string;
        lastSubmittedCommit: string | null;
      }[];
    };
  } | null;
  workspaceId: string;
  /** 带当前工作区的查询串，进详情页时不丢工作区。 */
  query: string;
  managers: readonly ManagerChoice[];
  baselines: readonly BaselineChoice[];
  packages: readonly PackageChoice[];
  /** 这个项目的提测记录，已经只含本项目（页面按 projectId 分好组再交下来）。 */
  releases: readonly ProjectRelease[];
  onClose: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** 写库成功后让页面重新取数：卡片、tab 计数与清单一起更新。 */
  onChanged: () => void;
};

/** 表格里的时间写法与提测记录列表一致：按 UTC 到分钟。 */
function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function ProjectModal({
  project,
  workspaceId,
  query,
  managers,
  baselines,
  packages,
  releases,
  onClose,
  onNotice,
  onError,
  onChanged,
}: ProjectModalProps) {
  const [state, setState] = useState<ModalState>(() =>
    initialModalState(project, managers, baselines),
  );
  const [pickedPackageId, setPickedPackageId] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, setPending] = useState(false);

  const { tab, draft } = state;
  const isNew = project === null;
  const softwareEntries = project?.software.entries ?? [];
  const tabs = projectTabs({
    softwareCount: project?.software.count ?? 0,
    releaseCount: releases.length,
  });
  const usableBaselines = baselineChoicesFor(baselines, draft.baselineId);

  const packageByName = new Map(packages.map((item) => [item.name, item]));
  const inList = new Set(softwareEntries.map((entry) => entry.packageName));
  const candidates = packages.filter((item) => !inList.has(item.name));
  // 受控下拉：选中的包被移除或还没选过时，显示第一个候选，点「加入清单」加的也是它。
  const addableId = candidates.some((item) => item.id === pickedPackageId)
    ? pickedPackageId
    : (candidates[0]?.id ?? "");

  /** 一个写库动作的共同外壳：挡住重复点击，结果翻成轻提示，成功后再刷新数据。 */
  async function run(
    work: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>,
    afterOk: () => void = onChanged,
  ): Promise<void> {
    if (pending) {
      return;
    }

    setPending(true);

    try {
      const result = await work();

      if (!result.ok) {
        onError(result.message);
        return;
      }

      onNotice(result.message);
      afterOk();
    } catch (error) {
      // 服务端动作在「还没走到返回结果就抛了」时（例如读库失败）会让 Promise 直接 reject，
      // 这里兜住：给一句能显示的提示，不要把按钮恢复成「什么都没发生」的样子。
      console.error("项目弹窗的写库动作失败：", error);
      onError("操作失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  async function saveBasic(): Promise<void> {
    await run(
      () =>
        project === null
          ? applyCreateProject(workspaceId, draft)
          : applyUpdateProject(project.id, draft),
      // 新建成功后弹窗收起：卡片的弹窗由页面重取数据后重新出现，与原型一致。
      project === null
        ? () => {
            onClose();
            onChanged();
          }
        : onChanged,
    );
  }

  async function removePackage(packageName: string): Promise<void> {
    const pkg = packageByName.get(packageName);

    if (project === null || pkg === undefined) {
      onError("这个软件包不在平台登记里，先去「软件包」页补登记。");
      return;
    }

    await run(() => applyRemoveSoftware(project.id, pkg.id));
  }

  async function addPackage(): Promise<void> {
    const pkg = packages.find((item) => item.id === addableId);

    if (project === null || pkg === undefined) {
      return;
    }

    await run(() => applyAddSoftware(project.id, pkg.id, pkg.defaultBranch));
  }

  async function deleteProject(): Promise<void> {
    if (project === null) {
      return;
    }

    await run(
      () => applyDeleteProject(project.id),
      () => {
        onClose();
        onChanged();
      },
    );
  }

  // 二次确认：原型用 confirmDialog 把整层弹窗换成确认框，取消即关闭。
  if (confirmingDelete) {
    return (
      <div className="modal-root">
        <Modal
          className="modal"
          title="删除这个项目？"
          onClose={onClose}
          footer={
            <>
              <div className="spacer" />
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={deleteProject}
                disabled={pending}
              >
                {pending ? "删除中…" : "删除项目"}
              </button>
            </>
          }
        >
          <p>
            只删平台里的项目配置，<b>不动 CRP 上的任何东西</b>
            。名下的提测记录会保留，但不再归属这个项目。
          </p>
        </Modal>
      </div>
    );
  }

  const footer = isNew ? (
    <>
      <div className="spacer" />
      <button type="button" className="btn" onClick={onClose}>
        取消
      </button>
      <button type="button" className="btn btn-primary" onClick={saveBasic} disabled={pending}>
        {pending ? "创建中…" : "创建项目"}
      </button>
    </>
  ) : tab === "danger" ? (
    <>
      <div className="spacer" />
      <button type="button" className="btn" onClick={onClose}>
        关闭
      </button>
    </>
  ) : (
    <>
      <div className="spacer" />
      <button type="button" className="btn" onClick={onClose}>
        取消
      </button>
      <button type="button" className="btn btn-primary" onClick={saveBasic} disabled={pending}>
        {pending ? "保存中…" : "保存"}
      </button>
    </>
  );

  return (
    <div className="modal-root">
      <ModalScrim onClose={onClose}>
        <div className="modal is-wide" role="dialog" aria-modal="true" aria-label={isNew ? "新建项目" : `编辑项目 ${project.name}`}>
          <div className="modal-hd">
            <h2>{isNew ? "新建项目" : project.name}</h2>
            <span className="modal-sub">{isNew ? "项目边界就是提测边界" : project.key}</span>
            <div className="spacer" />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <Icon name="x" />
            </button>
          </div>

          <div className="tabs" role="tablist" aria-label="项目分区">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                className="tab"
                role="tab"
                aria-selected={item.key === tab}
                onClick={() => setState((current) => switchTab(current, item.key))}
              >
                {item.label}
                {item.count === undefined ? null : <span className="tab-n num">{item.count}</span>}
              </button>
            ))}
          </div>

          <div className="modal-bd">
            {tab === "basic" ? (
              <BasicFields
                draft={draft}
                isNew={isNew}
                managers={managers}
                baselines={usableBaselines}
                onChange={(patch) => setState((current) => editDraft(current, patch))}
              />
            ) : null}

            {tab === "software" ? (
              <SoftwareTab
                isNew={isNew}
                entries={softwareEntries}
                packageByName={packageByName}
                candidates={candidates}
                addableId={addableId}
                pending={pending}
                onPick={setPickedPackageId}
                onAdd={addPackage}
                onRemove={removePackage}
              />
            ) : null}

            {tab === "releases" ? <ReleasesTab releases={releases} query={query} /> : null}

            {tab === "danger" ? (
              <DangerTab isNew={isNew} onDelete={() => setConfirmingDelete(true)} />
            ) : null}
          </div>

          <div className="modal-ft">{footer}</div>
        </div>
      </ModalScrim>
    </div>
  );
}

export type BasicFieldsProps = {
  draft: BasicDraft;
  isNew: boolean;
  managers: readonly ManagerChoice[];
  baselines: readonly BaselineChoice[];
  onChange: (patch: Partial<BasicDraft>) => void;
};

/** 基本信息 tab：名称、标识（编辑时只读）、项目经理、CRP 基线、说明。 */
export function BasicFields({ draft, isNew, managers, baselines, onChange }: BasicFieldsProps) {
  return (
    <>
      <div className="form-row2">
        <label className="field">
          <span className="label">项目名称</span>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="例如：桌面核心 V25"
          />
        </label>
        <label className="field">
          <span className="label">项目标识</span>
          <input
            className="input"
            value={draft.key}
            onChange={(event) => onChange({ key: event.target.value })}
            placeholder="desktop-core"
            disabled={!isNew}
          />
          {isNew ? null : <div className="note">标识创建后不能改，改动会让外部引用失效。</div>}
        </label>
      </div>

      <div className="form-row2">
        <label className="field">
          <span className="label">项目经理</span>
          <select
            className="select"
            value={draft.projectManagerId}
            onChange={(event) => onChange({ projectManagerId: event.target.value })}
          >
            {managers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name}
              </option>
            ))}
          </select>
          {managers.length === 0 ? (
            <div className="note">这个工作区还没有项目经理，先去「项目经理」页新建一位。</div>
          ) : null}
        </label>
        <label className="field">
          <span className="label">CRP 基线</span>
          <select
            className="select"
            value={draft.baselineId}
            onChange={(event) => onChange({ baselineId: event.target.value })}
          >
            {baselines.map((baseline) => (
              <option key={baseline.id} value={baseline.id}>
                {baseline.name}
                {baseline.state === "synced" ? "" : `（${baseline.stateLabel}）`}
              </option>
            ))}
          </select>
          {baselines.length === 0 ? (
            <div className="note">还没有可用的基线，先去「基线」页同步一条。</div>
          ) : null}
        </label>
      </div>

      <label className="field">
        <span className="label">项目说明</span>
        <textarea
          className="textarea"
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder="这个项目负责的范围"
        />
      </label>

      <div className="tip">
        <Icon name="info" />
        <div>
          <b>项目里的全部软件包都会在提测时一起提交。</b>
          顺序按依赖排，用户不能改。基线决定提交到 CRP 的哪条分支。
        </div>
      </div>
    </>
  );
}

export type SoftwareTabProps = {
  isNew: boolean;
  entries: readonly {
    packageName: string;
    trackedBranch: string;
    lastSubmittedCommit: string | null;
  }[];
  packageByName: ReadonlyMap<string, PackageChoice>;
  candidates: readonly PackageChoice[];
  addableId: string;
  pending: boolean;
  onPick: (packageId: string) => void;
  onAdd: () => void;
  onRemove: (packageName: string) => void;
};

/** 软件包清单 tab：按依赖顺序列出、移除、从已登记的包里挑一个加进来。 */
export function SoftwareTab({
  isNew,
  entries,
  packageByName,
  candidates,
  addableId,
  pending,
  onPick,
  onAdd,
  onRemove,
}: SoftwareTabProps) {
  if (isNew) {
    return (
      <div className="empty">
        <div className="empty-ico" aria-hidden="true">
          <Icon name="info" />
        </div>
        <div className="empty-t">新建的项目还没有软件包</div>
        <div className="empty-d">先把基本信息保存下来，再回来往清单里加包。</div>
      </div>
    );
  }

  return (
    <div className="stack">
      {entries.length === 0 ? (
        <div className="empty">
          <div className="empty-ico" aria-hidden="true">
            <Icon name="empty" />
          </div>
          <div className="empty-t">这个项目还没有软件包</div>
          <div className="empty-d">从下面加一个，或者先去「软件包」页登记。</div>
        </div>
      ) : (
        <div className="pick-list">
          {entries.map((entry, index) => {
            const pkg = packageByName.get(entry.packageName);

            return (
              <div className="pick" key={entry.packageName}>
                <span className="step-n num">{index + 1}</span>
                <span>
                  <span className="pick-t">{entry.packageName}</span>
                  <span className="pick-d">
                    {" "}
                    {entry.trackedBranch} · 当前版本 {pkg?.currentVersion ?? "未登记"} ·{" "}
                    {entry.lastSubmittedCommit === null
                      ? "未提测"
                      : `上次提测 ${entry.lastSubmittedCommit.slice(0, 12)}`}
                  </span>
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => onRemove(entry.packageName)}
                  disabled={pending}
                >
                  移除
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="form-row2">
        <label className="field">
          <span className="label">添加软件包</span>
          <select
            className="select"
            value={addableId}
            onChange={(event) => onPick(event.target.value)}
            disabled={candidates.length === 0}
          >
            {candidates.length === 0 ? (
              <option value="">没有可加的包</option>
            ) : (
              candidates.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.name} · {pkg.defaultBranch}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="field">
          <span className="label">&nbsp;</span>
          <button
            type="button"
            className="btn"
            onClick={onAdd}
            disabled={pending || addableId === ""}
          >
            <Icon name="plus" />
            加入清单
          </button>
        </div>
      </div>

      <div className="tip">
        <Icon name="info" />
        <div>
          <b>顺序由软件包依赖决定，不按添加顺序。</b>
          这里只决定「提测哪些包」，排第几位由依赖算。
        </div>
      </div>
    </div>
  );
}

/** 提测记录 tab：只列这个项目的提测，点行首的版本号进详情。 */
export function ReleasesTab({
  releases,
  query,
}: {
  releases: readonly ProjectRelease[];
  query: string;
}) {
  if (releases.length === 0) {
    return (
      <div className="empty">
        <div className="empty-ico" aria-hidden="true">
          <Icon name="empty" />
        </div>
        <div className="empty-t">这个项目还没有提测</div>
        <div className="empty-d">从项目卡上的「发起提测」开始。</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>提测记录</th>
              <th className="num">轮次</th>
              <th>状态</th>
              <th>创建人</th>
              <th className="num">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr className="is-clickable" key={release.id}>
                <td>
                  <Link href={`/releases/${release.id}${query}`}>
                    <strong>{release.version}</strong>
                  </Link>
                </td>
                <td className="num">第 {release.revision} 轮</td>
                <td>
                  <span className={`dot ${releaseStatusTone(release.status)}`}>
                    {releaseStatusLabel(release.status)}
                  </span>
                </td>
                <td>{release.createdByName}</td>
                <td className="num">{formatTime(release.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="tip">
        <Icon name="info" />
        <div>
          <b>这里只列这个项目的提测。</b>点版本号进详情。
        </div>
      </div>
    </div>
  );
}

/** 危险操作 tab：只放删除，外面包一层「只删平台配置，不动 CRP」的说明。 */
export function DangerTab({ isNew, onDelete }: { isNew: boolean; onDelete: () => void }) {
  if (isNew) {
    return (
      <div className="empty">
        <div className="empty-ico" aria-hidden="true">
          <Icon name="info" />
        </div>
        <div className="empty-t">新建的项目还不能删除</div>
        <div className="empty-d">先保存，再回来。</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="risk">
        <Icon name="alert" />
        <div>
          <b>删除项目会做什么</b>
          <br />
          只删平台里的项目配置与软件清单，<b>不动 CRP 上的任何东西</b>
          。名下的提测记录会保留，但不再归属这个项目。
        </div>
      </div>
      <div>
        <button type="button" className="btn btn-danger" onClick={onDelete}>
          删除这个项目
        </button>
      </div>
    </div>
  );
}
