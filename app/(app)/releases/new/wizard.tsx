"use client";

/**
 * 创建提测的三步向导（design.md 第八节「提测流程契约」）。
 *
 * 为什么是一个客户端组件：三步之间要带着「每个包选了哪个分支、哪个 Commit、自定义 Tag」
 * 这些临时状态来回走，服务端渲染每步都要把它们编码进网址，反而更难读。
 *
 * 结构照原型 `openWizard` / `drawWizard`：
 *
 * ```
 * .modal.is-wide
 *   .modal-hd   「创建提测」+「第 N 步，共 3 步」+ 关闭
 *   .steps      01 项目归属 / 02 检查仓库更新 / 03 确认提测
 *   .modal-bd   当前这一步的内容（只有当前步，不堆叠）
 *   .modal-ft   当前这一步的按钮
 * ```
 *
 * 三步的显示分别在 `stepProject.tsx`、`stepReview.tsx`、`stepConfirm.tsx`，提交成功后的结果页在
 * `createdRelease.tsx`。按钮放在弹窗底部由这里按步骤给出，文案逐字照 design.md 第八节的表。
 *
 * 边界：
 *
 * - 仓库数据（分支、提交、代码版本）全部由服务端动作现取（`actions.ts`），这里不拼 Gerrit 请求；
 * - 阻断条件来自服务端算出的 `readiness`，提交按钮按它禁用，但**不是唯一一道**：
 *   `POST /api/releases` 会再判一次，改前端绕不过去；
 * - 提测版本 = 自定义 Tag（填了的话）否则代码版本，规则来自 `lib/releases/snapshot.ts`，
 *   这里只做同样的展示，不另写一套。
 */

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useId, useRef, useState, useTransition } from "react";

import { Icon } from "@/components/icons";
import { ModalScrim } from "@/components/modal";
import { Toast } from "@/components/toast";
import { validateReleaseTag } from "@/lib/integrations/crp/tag";
import type {
  PackageRefresh,
  ReleaseBlocker,
  ReleaseProjectChoice,
} from "@/lib/releases";
// 只从快照模块引这一个纯函数：提测版本与「有没有更新」的规则在服务端只有一份，
// 从 `@/lib/releases` 的出口引会连带把服务端模块（Prisma）拉进客户端包。
import { buildSnapshotPlan } from "@/lib/releases/snapshot";
import { readErrorMessage } from "../../../http-error";
import {
  loadPackageCommitsAction,
  readPackageChangelogAction,
  refreshProjectPackagesAction,
} from "./actions";
import { CreatedRelease } from "./createdRelease";
import { StepConfirm, type ConfirmRow } from "./stepConfirm";
import { StepProject } from "./stepProject";
import { StepReview, type ReviewRow } from "./stepReview";
import {
  WIZARD_STEPS,
  type Selection,
  type Step,
  type SubmitResult,
  type WizardFilter,
} from "./wizardTypes";

/**
 * 按快照规则算出这个包的提测版本与「有没有更新」。
 *
 * 直接调 `buildSnapshotPlan()`：提测版本取自定义 Tag 或代码版本、「有更新」按上次提交的
 * Commit 比较，这两条规则在写库那一侧就是它，页面不另写一份。
 */
function planOf(item: PackageRefresh, selection: Selection) {
  return buildSnapshotPlan({
    packageName: item.packageName,
    branch: selection.branch,
    commitSha: selection.commitSha,
    codeVersion: selection.codeVersion,
    repoVersion: item.repoVersion,
    customTag: selection.customTag,
    lastSubmittedCommit: item.lastSubmittedCommit,
  });
}

/** 自定义 Tag 的格式问题；没填或合法返回 `null`。规则来自 A2 实测的 CRP 限制。 */
function tagErrorOf(selection: Selection): string | null {
  const tag = selection.customTag.trim();
  return tag === "" ? null : validateReleaseTag(tag);
}

/**
 * 第 2 步的筛选：更新状态 + 关键字（关键字对上包名或 Commit）。
 *
 * 「有更新 / 无变化」按三态判：`changed` 为 `null`（还没选中分支、或 Gerrit 读不到数据）的行
 * 两边都不算，与表格里给它显示的「未知」一致。写成 `(filter === "yes") === (row.changed === true)`
 * 会把这些行算进「仅无变化」，与单元格里的文案对不上。
 */
function matchesFilter(
  row: ReviewRow,
  filter: WizardFilter,
  query: string,
): boolean {
  const byState =
    filter === "all"
      ? true
      : filter === "yes"
        ? row.changed === true
        : row.changed === false;
  const needle = query.trim().toLowerCase();

  if (!byState) {
    return false;
  }

  return (
    needle === "" ||
    `${row.packageName} ${row.selection?.commitSha ?? ""}`
      .toLowerCase()
      .includes(needle)
  );
}

export function ReleaseWizard({
  projects,
}: {
  projects: ReleaseProjectChoice[];
}) {
  const router = useRouter();
  const titleId = useId();
  /** 关闭向导：回提测记录。× / 点遮罩 / 按 Esc 三条路都走它。 */
  const closeWizard = useCallback(() => router.push("/releases"), [router]);
  const [step, setStep] = useState<Step>(1);
  const [managerId, setManagerId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [version, setVersion] = useState("");
  const [description, setDescription] = useState("");

  const [packages, setPackages] = useState<PackageRefresh[] | null>(null);
  /** `packages` 属于哪个项目；换项目后必须重新拉，不能拿旧项目的分支提交。 */
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [readiness, setReadiness] = useState<{
    ready: boolean;
    blockers: ReleaseBlocker[];
    order: string[];
  } | null>(null);

  /** 第 2 步的筛选与就地编辑状态。 */
  const [filter, setFilter] = useState<WizardFilter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");

  /**
   * 仓库数据的请求序号。
   *
   * 切项目、切分支、切 Commit 都是一次异步往返，先发的请求可能后回来。没有序号时，
   * 切到 B 项目之后 A 项目那次请求会把 `packages` 覆盖回去，第 2 步就会把 A 的软件包清单
   * 挂在 B 的横幅下（服务端 `assertPackageSetMatches` 会拦住写库，但用户先看到的是错数据）。
   * 每次发起请求先自增，回来时对不上就整段丢弃。
   */
  const requestSeq = useRef(0);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const managers = [
    ...new Map(
      projects.map((item) => [item.managerId, item.managerName]),
    ).entries(),
  ];
  const managerProjects = projects.filter(
    (item) => item.managerId === managerId,
  );
  const project = projects.find((item) => item.id === projectId) ?? null;

  /**
   * 按服务端算出的投递顺序排好的行。
   *
   * 顺序不是用户排的（design.md 第八节第二条）：这里只按 `readiness.order` 摆位置，
   * 序号就是摆好之后的位次。清单里没进顺序的（理论上不该有）排在末尾。
   */
  const order = readiness?.order ?? [];
  const orderIndex = new Map(
    order.map((name, index) => [name, index] as const),
  );

  const reviewRows: ReviewRow[] = [...(packages ?? [])]
    .sort(
      (left, right) =>
        (orderIndex.get(left.packageName) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right.packageName) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((item, index) => {
      const selection = selections[item.packageName] ?? null;
      const plan = selection === null ? null : planOf(item, selection);

      return {
        packageName: item.packageName,
        repoPath: item.repoPath,
        order: index + 1,
        branches: item.branches,
        commits: item.commits,
        selection,
        repoVersion: item.repoVersion,
        releaseVersion: plan === null ? null : plan.releaseVersion,
        changed: plan === null ? null : plan.changed,
        tagError: selection === null ? null : tagErrorOf(selection),
        busy: busyPackage === item.packageName,
        unavailable: item.error,
      };
    });

  const visibleRows = reviewRows.filter((row) =>
    matchesFilter(row, filter, query),
  );
  const missingSelection = reviewRows.filter((row) => row.selection === null);
  const tagErrorCount = reviewRows.filter(
    (row) => row.tagError !== null,
  ).length;
  const packageErrors = (packages ?? []).flatMap((item) =>
    item.error === null
      ? []
      : [{ packageName: item.packageName, error: item.error }],
  );
  const packageWarnings = (packages ?? []).flatMap((item) =>
    item.warning === null
      ? []
      : [{ packageName: item.packageName, warning: item.warning }],
  );
  const changedCount = reviewRows.filter((row) => row.changed === true).length;

  const blocked = readiness === null || !readiness.ready;
  const loaded = packages !== null && packages.length > 0;

  const canGoNextFromProject = projectId !== "" && version.trim() !== "";
  const canGoNextFromReview =
    !blocked && loaded && missingSelection.length === 0 && tagErrorCount === 0;

  const canSubmit =
    !blocked &&
    !submitting &&
    loaded &&
    missingSelection.length === 0 &&
    tagErrorCount === 0 &&
    packageErrors.length === 0 &&
    version.trim() !== "";

  /** 第三步按投递顺序列出将要固化的内容；没有选择或没有读到数据的包不出现。 */
  const confirmRows: ConfirmRow[] = reviewRows.flatMap((row) => {
    const item = (packages ?? []).find(
      (entry) => entry.packageName === row.packageName,
    );

    if (row.selection === null || item === undefined) {
      return [];
    }

    const plan = planOf(item, row.selection);

    return [
      {
        packageName: row.packageName,
        branch: row.selection.branch,
        commitSha: row.selection.commitSha,
        codeVersion: row.selection.codeVersion,
        repoVersion: item.repoVersion,
        releaseVersion: plan.releaseVersion,
        custom: row.selection.customTag.trim() !== "",
        changed: plan.changed,
      },
    ];
  });

  /** 拉取整个项目的仓库数据，并把每个包的默认选择（跟踪分支最新提交）填好。 */
  function refresh(targetProjectId: string): void {
    setError(null);
    setNotice(null);

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    startRefresh(async () => {
      const response = await refreshProjectPackagesAction(targetProjectId);

      if (requestSeq.current !== seq) {
        return;
      }

      if (!response.ok) {
        setError(response.message);
        return;
      }

      setPackages(response.packages);
      setLoadedProjectId(targetProjectId);
      setReadiness({
        ready: response.readiness.ready,
        blockers: response.readiness.blockers,
        order: response.readiness.order,
      });

      const next: Record<string, Selection> = {};

      for (const item of response.packages) {
        if (item.selected !== null) {
          next[item.packageName] = { ...item.selected, customTag: "" };
        }
      }

      setSelections(next);
      setEditing(null);
    });
  }

  /** 第 1 步 → 第 2 步：先把必填项挡住，再进第 2 步并拉数据。 */
  function goToStep2(): void {
    if (projectId === "") {
      setError("请先选择要提测的项目。");
      return;
    }

    if (version.trim() === "") {
      setError("请填写 Topic 版本号。");
      return;
    }

    setError(null);
    setStep(2);

    if (loadedProjectId !== projectId) {
      refresh(projectId);
    }
  }

  /** 切分支：重新取该分支的提交，并默认选最新一条（代码版本随之重读）。 */
  function changeBranch(packageName: string, branch: string): void {
    setError(null);
    setBusyPackage(packageName);

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    void (async () => {
      const response = await loadPackageCommitsAction(
        projectId,
        packageName,
        branch,
      );

      if (requestSeq.current !== seq) {
        return;
      }

      setBusyPackage(null);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      setPackages((current) =>
        (current ?? []).map((item) =>
          item.packageName === packageName
            ? { ...item, commits: response.commits }
            : item,
        ),
      );

      const selected = response.selected;

      if (selected === null) {
        setSelections((current) => {
          const next = { ...current };
          delete next[packageName];
          return next;
        });
        return;
      }

      setSelections((current) => ({
        ...current,
        [packageName]: {
          ...selected,
          customTag: current[packageName]?.customTag ?? "",
        },
      }));
    })();
  }

  /** 切 Commit：重读这个提交的 `debian/changelog` 版本。 */
  function changeCommit(packageName: string, commitSha: string): void {
    setError(null);
    setBusyPackage(packageName);

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    void (async () => {
      const response = await readPackageChangelogAction(
        projectId,
        packageName,
        commitSha,
      );

      if (requestSeq.current !== seq) {
        return;
      }

      setBusyPackage(null);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      setSelections((current) => {
        const previous = current[packageName];

        if (previous === undefined) {
          return current;
        }

        return {
          ...current,
          [packageName]: {
            ...previous,
            commitSha,
            codeVersion: response.codeVersion,
          },
        };
      });
    })();
  }

  /** 进入某一行的自定义版本编辑：草稿先填当前值。 */
  function startTagEdit(packageName: string, currentTag: string): void {
    setEditing(packageName);
    setTagDraft(currentTag);
  }

  /** 保存自定义版本号：空白就删掉（回到代码版本），其余照 Tag 规则校验。 */
  function saveTag(packageName: string): void {
    const value = tagDraft.trim();
    const problem = value === "" ? null : validateReleaseTag(value);

    if (problem !== null) {
      setError(`提测版本号不能用：${problem}`);
      return;
    }

    setSelections((current) => {
      const previous = current[packageName];

      if (previous === undefined) {
        return current;
      }

      return { ...current, [packageName]: { ...previous, customTag: value } };
    });
    setEditing(null);
    setTagDraft("");
  }

  /** 恢复默认：删掉自定义版本，回到代码版本。 */
  function resetTag(packageName: string): void {
    setSelections((current) => {
      const previous = current[packageName];

      if (previous === undefined) {
        return current;
      }

      return { ...current, [packageName]: { ...previous, customTag: "" } };
    });
    setEditing(null);
    setTagDraft("");
  }

  /** 按拓扑顺序提交：顺序由服务端算出的 `readiness.order` 决定，不由表单顺序决定。 */
  async function submit(): Promise<void> {
    if (readiness === null) {
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload = {
      projectId,
      version: version.trim(),
      description: description.trim() === "" ? null : description.trim(),
      packages: confirmRows.map((row) => ({
        packageName: row.packageName,
        branch: row.branch,
        commitSha: row.commitSha,
        customTag: selections[row.packageName]?.customTag.trim() || null,
      })),
    };

    const response = await fetch("/api/releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSubmitting(false);

    if (!response.ok) {
      setError(await readErrorMessage(response, "创建提测失败"));
      return;
    }

    const body = (await response.json()) as SubmitResult;
    setResult(body);
    setNotice(
      `提测已创建：版本 ${body.version}，第 ${body.revision} 轮，${String(body.packageCount)} 条快照。`,
    );
  }

  if (result !== null) {
    return <CreatedRelease result={result} notice={notice ?? ""} />;
  }

  const stepsBar = (
    <div className="steps">
      {WIZARD_STEPS.map((entry, index) => (
        <Fragment key={entry.step}>
          <div
            className={`step ${entry.step === step ? "is-on" : entry.step < step ? "is-done" : ""}`}
          >
            <div className="step-n">
              {entry.step < step ? "✓" : String(entry.step).padStart(2, "0")}
            </div>
            <div className="step-t">{entry.title}</div>
          </div>
          {index === WIZARD_STEPS.length - 1 ? null : (
            <div className="step-line" />
          )}
        </Fragment>
      ))}
    </div>
  );

  const footer =
    step === 1 ? (
      <>
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => router.push("/releases")}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={goToStep2}
          disabled={!canGoNextFromProject}
        >
          检查项目仓库更新 →
        </button>
      </>
    ) : step === 2 ? (
      <>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setStep(1)}>
          上一步
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setStep(3)}
          disabled={!canGoNextFromReview}
        >
          确认版本信息 →
        </button>
      </>
    ) : (
      <>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setStep(2)}>
          返回调整版本
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {submitting ? "提交中…" : "在目标 CRP 基线上创建提测"}
        </button>
      </>
    );

  return (
    <>
      <div className="toast-stack" aria-live="polite">
        <Toast className="toast bad" role="alert" message={error} />
        <Toast className="toast ok" message={notice} />
      </div>

      <ModalScrim onClose={closeWizard}>
        <div
          className="modal is-wide"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="modal-hd">
            <h2 id={titleId}>创建提测</h2>
            <span className="modal-sub">第 {String(step)} 步，共 3 步</span>
            <div className="spacer" />
            <button
              type="button"
              className="icon-btn"
              onClick={closeWizard}
              aria-label="关闭"
            >
              <Icon name="x" />
            </button>
          </div>

          {stepsBar}

          <div className="modal-bd">
            {step === 1 ? (
              <StepProject
                managers={managers}
                managerProjects={managerProjects}
                managerId={managerId}
                projectId={projectId}
                version={version}
                description={description}
                project={project}
                onManagerChange={(nextManagerId) => {
                  setManagerId(nextManagerId);
                  setProjectId("");
                }}
                onProjectChange={(nextProjectId) => {
                  setProjectId(nextProjectId);
                  // 换项目就把上一个项目的分支选择丢掉：不丢的话会把 A 项目的提交写进 B 项目。
                  setPackages(null);
                  setSelections({});
                  setReadiness(null);
                  setLoadedProjectId(null);
                  setEditing(null);
                }}
                onVersionChange={setVersion}
                onDescriptionChange={setDescription}
              />
            ) : null}

            {step === 2 && project !== null ? (
              <StepReview
                project={project}
                refreshing={refreshing}
                loaded={packages !== null}
                rows={visibleRows}
                allCount={reviewRows.length}
                changedCount={changedCount}
                filter={filter}
                query={query}
                editing={editing}
                tagDraft={tagDraft}
                blockers={readiness === null ? [] : readiness.blockers}
                warnings={packageWarnings}
                errors={packageErrors}
                onRefresh={() => refresh(projectId)}
                onFilterChange={setFilter}
                onQueryChange={setQuery}
                onBranchChange={changeBranch}
                onCommitChange={changeCommit}
                onTagEdit={startTagEdit}
                onTagDraftChange={setTagDraft}
                onTagSave={saveTag}
                onTagReset={resetTag}
                onTagCancel={() => {
                  setEditing(null);
                  setTagDraft("");
                }}
              />
            ) : null}

            {step === 3 && project !== null ? (
              <StepConfirm
                project={project}
                version={version.trim()}
                rows={confirmRows}
                packageCount={reviewRows.length}
              />
            ) : null}
          </div>

          <div className="modal-ft">{footer}</div>
        </div>
      </ModalScrim>
    </>
  );
}
