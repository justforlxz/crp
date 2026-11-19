"use client";

/**
 * 创建提测的三步向导。
 *
 * 为什么是一个客户端组件：三步之间要带着「每个包选了哪个分支、哪个 Commit、自定义 Tag」
 * 这些临时状态来回走，服务端渲染每步都要把它们编码进网址，反而更难读。
 *
 * 这里只放状态与业务动作（拉取仓库数据、切分支、切 Commit、提交），三步的显示分别在
 * `stepProject.tsx`、`stepReview.tsx`、`stepConfirm.tsx`，提交成功后的结果页在
 * `createdRelease.tsx`：每一步只拿显示所需的数据，改动一步的布局不会碰到另外两步。
 *
 * 边界：
 *
 * - 仓库数据（分支、提交、代码版本）全部由服务端动作现取（`actions.ts`），这里不拼 Gerrit 请求；
 * - 阻断条件来自服务端算出的 `readiness`，提交按钮按它禁用，但**不是唯一一道**：
 *   `POST /api/releases` 会再判一次，改前端绕不过去；
 * - 提测版本 = 自定义 Tag（填了的话）否则代码版本，规则来自 `lib/releases/snapshot.ts`，
 *   这里只做同样的展示，不另写一套。
 */

import Link from "next/link";
import { useState, useTransition } from "react";

import { validateReleaseTag } from "@/lib/integrations/crp/tag";
import type { PackageRefresh, ReleaseBlocker, ReleaseProjectChoice } from "@/lib/releases";
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
import type { Selection, Step, SubmitResult } from "./wizardTypes";

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

export function ReleaseWizard({ projects }: { projects: ReleaseProjectChoice[] }) {
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

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const managers = [...new Map(projects.map((item) => [item.managerId, item.managerName])).entries()];
  const managerProjects = projects.filter((item) => item.managerId === managerId);
  const project = projects.find((item) => item.id === projectId) ?? null;

  /** 第二步的每一行：选择、提测版本、有没有更新、Tag 格式问题都按包算好。 */
  const reviewRows: ReviewRow[] = (packages ?? []).map((item) => {
    const selection = selections[item.packageName] ?? null;
    const plan = selection === null ? null : planOf(item, selection);

    return {
      packageName: item.packageName,
      repoPath: item.repoPath,
      repoVersion: item.repoVersion,
      branches: item.branches,
      commits: item.commits,
      selection,
      releaseVersion: plan === null ? null : plan.releaseVersion,
      changed: plan === null ? null : plan.changed,
      tagError: selection === null ? null : tagErrorOf(selection),
      busy: busyPackage === item.packageName,
    };
  });

  const missingSelection = reviewRows.filter((row) => row.selection === null);
  const tagErrorCount = reviewRows.filter((row) => row.tagError !== null).length;
  const packageErrors = (packages ?? []).flatMap((item) =>
    item.error === null ? [] : [{ packageName: item.packageName, error: item.error }],
  );
  const packageWarnings = (packages ?? []).flatMap((item) =>
    item.warning === null ? [] : [{ packageName: item.packageName, warning: item.warning }],
  );
  const changedCount = reviewRows.filter((row) => row.changed === true).length;

  const blocked = readiness === null || !readiness.ready;
  const canSubmit =
    !blocked &&
    !submitting &&
    packages !== null &&
    packages.length > 0 &&
    missingSelection.length === 0 &&
    tagErrorCount === 0 &&
    packageErrors.length === 0 &&
    version.trim() !== "";

  /** 第三步按投递顺序列出将要固化的内容；没有选择或没有读到数据的包不出现。 */
  const confirmRows: ConfirmRow[] = (readiness?.order ?? []).flatMap((name) => {
    const selection = selections[name];
    const item = (packages ?? []).find((entry) => entry.packageName === name);

    if (selection === undefined || item === undefined) {
      return [];
    }

    const plan = planOf(item, selection);

    return [
      {
        packageName: name,
        branch: selection.branch,
        commitSha: selection.commitSha,
        codeVersion: selection.codeVersion,
        repoVersion: item.repoVersion,
        releaseVersion: plan.releaseVersion,
        changed: plan.changed,
      },
    ];
  });

  /** 拉取整个项目的仓库数据，并把每个包的默认选择（跟踪分支最新提交）填好。 */
  function refresh(targetProjectId: string): void {
    setError(null);
    setNotice(null);

    startRefresh(async () => {
      const response = await refreshProjectPackagesAction(targetProjectId);

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
    });
  }

  function goToStep2(): void {
    if (projectId === "") {
      setError("请先选择要提测的项目。");
      return;
    }

    if (version.trim() === "") {
      setError("请填写 Topic 版本号。");
      return;
    }

    setStep(2);

    if (loadedProjectId !== projectId) {
      refresh(projectId);
    }
  }

  /** 切分支：重新取该分支的提交，并默认选最新一条（代码版本随之重读）。 */
  function changeBranch(packageName: string, branch: string): void {
    setError(null);
    setBusyPackage(packageName);

    void (async () => {
      const response = await loadPackageCommitsAction(projectId, packageName, branch);
      setBusyPackage(null);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      setPackages((current) =>
        (current ?? []).map((item) =>
          item.packageName === packageName ? { ...item, commits: response.commits } : item,
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
        [packageName]: { ...selected, customTag: current[packageName]?.customTag ?? "" },
      }));
    })();
  }

  /** 切 Commit：重读这个提交的 `debian/changelog` 版本。 */
  function changeCommit(packageName: string, commitSha: string): void {
    setError(null);
    setBusyPackage(packageName);

    void (async () => {
      const response = await readPackageChangelogAction(projectId, packageName, commitSha);
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
          [packageName]: { ...previous, commitSha, codeVersion: response.codeVersion },
        };
      });
    })();
  }

  function changeTag(packageName: string, customTag: string): void {
    setSelections((current) => {
      const previous = current[packageName];

      if (previous === undefined) {
        return current;
      }

      return { ...current, [packageName]: { ...previous, customTag } };
    });
  }

  /** 按拓扑顺序提交：顺序由服务端算出的 `readiness.order` 决定，不由表单顺序决定。 */
  async function submit(): Promise<void> {
    if (readiness === null) {
      return;
    }

    setSubmitting(true);
    setError(null);

    const order = readiness.order.filter((name) => selections[name] !== undefined);
    const payload = {
      projectId,
      version: version.trim(),
      description: description.trim() === "" ? null : description.trim(),
      packages: order.map((name) => {
        const selection = selections[name] as Selection;

        return {
          packageName: name,
          branch: selection.branch,
          commitSha: selection.commitSha,
          customTag: selection.customTag.trim() === "" ? null : selection.customTag.trim(),
        };
      }),
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
    setNotice(`提测已创建：版本 ${body.version}，第 ${body.revision} 轮，${body.packageCount} 条快照。`);
  }

  if (result !== null) {
    return <CreatedRelease result={result} notice={notice ?? ""} />;
  }

  return (
    <>
      <p>
        三步：选项目 → 检查仓库更新 → 确认提交。提交后每个软件包的分支、Commit 与三个版本号
        会固化成快照，之后改项目配置也不会改变这次提测的记录。
      </p>
      <p>
        <Link href="/projects">返回项目列表</Link>
      </p>

      {error === null ? null : <p className="alert alert--error" role="alert">操作失败：{error}</p>}
      {notice === null ? null : <p className="alert alert--info" role="status">{notice}</p>}

      <StepProject
        active={step === 1}
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
          setStep(1);
        }}
        onVersionChange={setVersion}
        onDescriptionChange={setDescription}
        onNext={goToStep2}
      />

      {step >= 2 ? (
        <StepReview
          refreshing={refreshing}
          loaded={packages !== null}
          order={readiness === null ? null : readiness.order}
          blockers={readiness === null ? [] : readiness.blockers}
          rows={reviewRows}
          packageCount={(packages ?? []).length}
          changedCount={changedCount}
          warnings={packageWarnings}
          errors={packageErrors}
          canGoNext={!blocked && packages !== null && packages.length > 0}
          onRefresh={() => refresh(projectId)}
          onBranchChange={changeBranch}
          onCommitChange={changeCommit}
          onTagChange={changeTag}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ) : null}

      {step >= 3 ? (
        <StepConfirm
          rows={confirmRows}
          submitting={submitting}
          canSubmit={canSubmit}
          onBack={() => setStep(2)}
          onSubmit={() => void submit()}
        />
      ) : null}
    </>
  );
}
