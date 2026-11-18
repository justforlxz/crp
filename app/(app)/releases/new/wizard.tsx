"use client";

/**
 * 创建提测的三步向导。
 *
 * 为什么是一个客户端组件：三步之间要带着「每个包选了哪个分支、哪个 Commit、自定义 Tag」
 * 这些临时状态来回走，服务端渲染每步都要把它们编码进网址，反而更难读。
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
import { styles } from "../../../styles";
import {
  loadPackageCommitsAction,
  readPackageChangelogAction,
  refreshProjectPackagesAction,
} from "./actions";

/** 一个软件包当前的选择。 */
type Selection = {
  branch: string;
  commitSha: string;
  /** 所选 Commit 的 changelog 版本。 */
  codeVersion: string;
  /** 自定义 Tag；空串表示没填。 */
  customTag: string;
};

/** 提交成功后的返回体（`POST /api/releases` 的 201）。 */
type SubmitResult = {
  id: string;
  version: string;
  revision: number;
  packageCount: number;
  changedCount: number;
  summary: string;
  order: string[];
  snapshots: Array<{
    packageName: string;
    branch: string;
    commitSha: string;
    codeVersion: string;
    repoVersion: string | null;
    releaseVersion: string;
    changed: boolean;
  }>;
};

type Step = 1 | 2 | 3;

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

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

  const selectedPackages = (packages ?? []).map((item) => ({
    package: item,
    selection: selections[item.packageName] ?? null,
  }));
  const missingSelection = selectedPackages.filter((item) => item.selection === null);
  const tagErrors = selectedPackages
    .map((item) => ({
      packageName: item.package.packageName,
      reason: item.selection === null ? null : tagErrorOf(item.selection),
    }))
    .filter((item): item is { packageName: string; reason: string } => item.reason !== null);
  const packageErrors = (packages ?? []).filter((item) => item.error !== null);
  const packageWarnings = (packages ?? []).filter((item) => item.warning !== null);
  const changedCount = selectedPackages.filter(
    (item) => item.selection !== null && planOf(item.package, item.selection).changed,
  ).length;

  const blocked = readiness === null || !readiness.ready;
  const canSubmit =
    !blocked &&
    !submitting &&
    packages !== null &&
    packages.length > 0 &&
    missingSelection.length === 0 &&
    tagErrors.length === 0 &&
    packageErrors.length === 0 &&
    version.trim() !== "";

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
    return (
      <main>
        <h1>提测已创建</h1>
        <p role="status">{notice}</p>
        <dl>
          <dt>提测 ID</dt>
          <dd>
            <code>{result.id}</code>
          </dd>
          <dt>Topic 版本号</dt>
          <dd>{result.version}</dd>
          <dt>轮次</dt>
          <dd>{result.revision}</dd>
          <dt>快照条数</dt>
          <dd>{result.packageCount}</dd>
          <dt>投递顺序（上游在前）</dt>
          <dd>
            <code>{result.order.join(" → ")}</code>
          </dd>
          <dt>状态</dt>
          <dd>
            <code>pending</code>（已创建、尚未投递；投递由 A12 负责）
          </dd>
        </dl>

        <h2>快照</h2>
        <table>
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
            {result.snapshots.map((snapshot) => (
              <tr key={snapshot.packageName}>
                <td>{snapshot.packageName}</td>
                <td>
                  <code>{snapshot.branch}</code>
                </td>
                <td>
                  <code>{shortSha(snapshot.commitSha)}</code>
                </td>
                <td>{snapshot.codeVersion}</td>
                <td>{snapshot.repoVersion ?? "—"}</td>
                <td>{snapshot.releaseVersion}</td>
                <td>{snapshot.changed ? "有更新" : "无变化"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p>
          <Link href="/projects">返回项目列表</Link>
          {"　"}
          <Link href="/releases/new">再建一个提测</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>创建提测</h1>
      <p>
        三步：选项目 → 检查仓库更新 → 确认提交。提交后每个软件包的分支、Commit 与三个版本号
        会固化成快照，之后改项目配置也不会改变这次提测的记录。
      </p>
      <p>
        <Link href="/projects">返回项目列表</Link>
      </p>

      {error === null ? null : <p role="alert">操作失败：{error}</p>}
      {notice === null ? null : <p role="status">{notice}</p>}

      <h2>第一步：项目归属</h2>

      <p>
        <label style={styles.label} htmlFor="release-manager">
          项目经理
        </label>
        <select
          id="release-manager"
          style={styles.input}
          value={managerId}
          onChange={(event) => {
            setManagerId(event.target.value);
            setProjectId("");
          }}
          disabled={step !== 1}
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
        <label style={styles.label} htmlFor="release-project">
          项目
        </label>
        <select
          id="release-project"
          style={styles.input}
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            // 换项目就把上一个项目的分支选择丢掉：不丢的话会把 A 项目的提交写进 B 项目。
            setPackages(null);
            setSelections({});
            setReadiness(null);
            setLoadedProjectId(null);
            setStep(1);
          }}
          disabled={step !== 1 || managerId === ""}
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
        <div role="alert">
          <p>这个项目现在不能提测：</p>
          <ul>
            {project.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p>
        <label style={styles.label} htmlFor="release-version">
          Topic 版本号
        </label>
        <input
          id="release-version"
          style={styles.input}
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          placeholder="25.0.2"
          disabled={step !== 1}
        />{" "}
        同一项目内唯一，重复会被拒绝。
      </p>

      <p>
        <label style={styles.label} htmlFor="release-description">
          提测说明（可不填）
        </label>
        <input
          id="release-description"
          style={styles.input}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={step !== 1}
        />
      </p>

      {step === 1 ? (
        <p>
          <button
            type="button"
            style={styles.button}
            onClick={goToStep2}
            disabled={projectId === "" || version.trim() === ""}
          >
            下一步：检查仓库更新
          </button>
        </p>
      ) : null}

      {step >= 2 ? (
        <>
          <h2>第二步：检查仓库更新</h2>
          <p>
            <button
              type="button"
              style={styles.smallButton}
              onClick={() => refresh(projectId)}
              disabled={refreshing}
            >
              {refreshing ? "正在从 Gerrit 刷新…" : "从 Gerrit 刷新"}
            </button>
            {readiness === null ? null : (
              <>
                {" "}
                <code>{readiness.order.join(" → ")}</code>
              </>
            )}
          </p>

          {readiness !== null && readiness.blockers.length > 0 ? (
            <div role="alert">
              <p>提交被阻断：</p>
              <ul>
                {readiness.blockers.map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {packages === null ? (
            <p>{refreshing ? "正在读取分支与提交…" : "还没有读取仓库数据。"}</p>
          ) : (
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
                {selectedPackages.map(({ package: item, selection }) => (
                  <tr key={item.packageName}>
                    <td>
                      {item.packageName}
                      <br />
                      <small>{item.repoPath}</small>
                    </td>
                    <td>
                      <select
                        style={styles.input}
                        value={selection?.branch ?? ""}
                        onChange={(event) => changeBranch(item.packageName, event.target.value)}
                        disabled={busyPackage === item.packageName || item.branches.length === 0}
                      >
                        {item.branches.length === 0 ? <option value="">（读不到分支）</option> : null}
                        {item.branches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        style={styles.input}
                        value={selection?.commitSha ?? ""}
                        onChange={(event) => changeCommit(item.packageName, event.target.value)}
                        disabled={busyPackage === item.packageName || item.commits.length === 0}
                      >
                        {item.commits.length === 0 ? <option value="">（读不到提交）</option> : null}
                        {item.commits.map((commit) => (
                          <option key={commit.sha} value={commit.sha}>
                            {shortSha(commit.sha)} {commit.summary}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{selection?.codeVersion ?? "—"}</td>
                    <td>{item.repoVersion ?? "—"}</td>
                    <td>
                      <input
                        style={styles.input}
                        value={selection?.customTag ?? ""}
                        onChange={(event) => changeTag(item.packageName, event.target.value)}
                        placeholder={selection?.codeVersion ?? "留空用代码版本"}
                      />
                      <small>提测版本：{selection === null ? "—" : planOf(item, selection).releaseVersion}</small>
                      {selection === null ? null : tagErrorOf(selection) === null ? null : (
                        <small role="alert"> {tagErrorOf(selection)}</small>
                      )}
                    </td>
                    <td>
                      {selection === null ? "—" : planOf(item, selection).changed ? "有更新" : "无变化"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {packageWarnings.length > 0 ? (
            <div role="status">
              <p>这些软件包的数据可用，但需要看一眼：</p>
              <ul>
                {packageWarnings.map((item) => (
                  <li key={item.packageName}>
                    {item.packageName}：{item.warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {packageErrors.length > 0 ? (
            <div role="alert">
              <p>这些软件包读不到仓库数据：</p>
              <ul>
                {packageErrors.map((item) => (
                  <li key={item.packageName}>
                    {item.packageName}：{item.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {packages === null ? null : (
            <p role="status">
              本次将提测 {packages.length} 个软件，其中 {changedCount} 个有更新。
              「无变化」的软件包同样会进提测。
            </p>
          )}

          <p>
            <button type="button" style={styles.smallButton} onClick={() => setStep(1)}>
              上一步
            </button>{" "}
            <button
              type="button"
              style={styles.button}
              onClick={() => setStep(3)}
              disabled={blocked || packages === null || packages.length === 0}
            >
              下一步：确认
            </button>
          </p>
        </>
      ) : null}

      {step >= 3 ? (
        <>
          <h2>第三步：确认提交</h2>
          <table>
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
              {(readiness?.order ?? []).map((name) => {
                const selection = selections[name];
                const item = (packages ?? []).find((entry) => entry.packageName === name);

                if (selection === undefined || item === undefined) {
                  return null;
                }

                return (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <code>{selection.branch}</code>
                    </td>
                    <td>
                      <code>{shortSha(selection.commitSha)}</code>
                    </td>
                    <td>{selection.codeVersion}</td>
                    <td>{item.repoVersion ?? "—"}</td>
                    <td>{planOf(item, selection).releaseVersion}</td>
                    <td>{planOf(item, selection).changed ? "有更新" : "无变化"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p>
            提交后状态为 <code>pending</code>（已创建、尚未投递），投递由 A12 按上面的顺序进行。
          </p>

          <p>
            <button type="button" style={styles.smallButton} onClick={() => setStep(2)}>
              上一步
            </button>{" "}
            <button
              type="button"
              style={styles.button}
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {submitting ? "提交中…" : "提交提测"}
            </button>
          </p>
        </>
      ) : null}
    </main>
  );
}
