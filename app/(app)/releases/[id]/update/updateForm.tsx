"use client";

/**
 * 更新提测的客户端表单：补包、换包、确认清单、提交。
 *
 * 边界与建提测的三步向导一致：
 *
 * - 仓库数据（分支、提交、代码版本）全部由服务端动作现取（`../new/actions`），这里不拼 Gerrit 请求；
 * - 「提交给 CRP 的代码版本」由服务端现读，表单只负责选分支与 Commit；
 * - 「能不能改」由服务端现读 CRP 工作流进度决定，这里的禁用只是提示，直接调接口也绕不过去；
 * - 提交前先打一次 `?dryRun=1`，把「将放弃 N 个、重投 N 个」的清单摆出来让人确认一次。
 *
 * 只有真的改动的包才会进 `replace`：把没改的包也带上，会连带重投它的整条下游链，
 * 那正是「补一个包就重投所有已成功包」的反面要求。
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { PackageRefresh, ReleaseUpdatePlan } from "@/lib/releases";
import { readErrorMessage } from "../../../../http-error";
import { styles } from "../../../../styles";
import {
  loadPackageCommitsAction,
  readPackageChangelogAction,
  refreshProjectPackagesAction,
} from "../../new/actions";

/** 现有软件包在快照里固化的值。 */
type CurrentPackage = {
  packageName: string;
  branch: string;
  commitSha: string;
  codeVersion: string;
  releaseVersion: string;
  snapshotStatus: string;
};

/** 还能补进来的软件包。 */
type Candidate = {
  packageName: string;
  repoPath: string;
  trackedBranch: string;
};

/** 一个现有软件包的选择。 */
type Draft = {
  branch: string;
  commitSha: string;
  /** 自定义 Tag；空串表示不改提测版本（重投时 Tag 不变）。 */
  customTag: string;
};

/** 一行待补的软件包。 */
type AppendRow = {
  id: number;
  packageName: string;
  branch: string;
  commitSha: string;
  codeVersion: string;
  customTag: string;
};

type UpdateResult = {
  revision: number;
  abandonedCrpReleaseIds: string[];
  redispatchedPackageNames: string[];
  advanceError: string | null;
};

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function UpdateReleaseForm({
  releaseId,
  projectId,
  currentPackages,
  candidates,
  locked,
}: {
  releaseId: string;
  projectId: string;
  currentPackages: CurrentPackage[];
  candidates: Candidate[];
  locked: boolean;
}) {
  const router = useRouter();

  const [refreshes, setRefreshes] = useState<PackageRefresh[] | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      currentPackages.map((item) => [
        item.packageName,
        { branch: item.branch, commitSha: item.commitSha, customTag: "" },
      ]),
    ),
  );
  const [appended, setAppended] = useState<AppendRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<ReleaseUpdatePlan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);

  const refreshedByName = new Map((refreshes ?? []).map((item) => [item.packageName, item]));

  // 页面打开就把分支与提交读回来：没有这份数据，两个下拉框都是空的。
  useEffect(() => {
    if (locked) {
      return;
    }

    startRefresh(async () => {
      const response = await refreshProjectPackagesAction(projectId);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      setRefreshes(response.packages);
    });
  }, [locked, projectId]);

  function patchRefresh(packageName: string, patch: Partial<PackageRefresh>): void {
    setRefreshes((current) =>
      (current ?? []).map((item) =>
        item.packageName === packageName ? { ...item, ...patch } : item,
      ),
    );
  }

  /** 换包的包切分支：重新取提交，并默认选最新一条。 */
  function changeDraftBranch(packageName: string, branch: string): void {
    setError(null);
    setBusy(packageName);

    void (async () => {
      const response = await loadPackageCommitsAction(projectId, packageName, branch);
      setBusy(null);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      patchRefresh(packageName, { commits: response.commits });

      const selected = response.selected;

      setDrafts((current) => ({
        ...current,
        [packageName]: {
          branch,
          commitSha: selected?.commitSha ?? "",
          customTag: current[packageName]?.customTag ?? "",
        },
      }));
    })();
  }

  function changeDraftCommit(packageName: string, commitSha: string): void {
    setDrafts((current) => ({
      ...current,
      [packageName]: { ...(current[packageName] as Draft), commitSha },
    }));
  }

  function changeDraftTag(packageName: string, customTag: string): void {
    setDrafts((current) => ({
      ...current,
      [packageName]: { ...(current[packageName] as Draft), customTag },
    }));
  }

  /** 补包选包：用项目清单里这个包的跟踪分支与最新提交作为默认值。 */
  function selectAppendPackage(id: number, packageName: string): void {
    const row = refreshedByName.get(packageName);

    setAppended((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              packageName,
              branch: row?.selected?.branch ?? "",
              commitSha: row?.selected?.commitSha ?? "",
              codeVersion: row?.selected?.codeVersion ?? "",
            }
          : item,
      ),
    );
    setPlan(null);
  }

  function changeAppendBranch(rowId: number, packageName: string, branch: string): void {
    setError(null);
    setBusy(packageName);

    void (async () => {
      const response = await loadPackageCommitsAction(projectId, packageName, branch);
      setBusy(null);

      if (!response.ok) {
        setError(response.message);
        return;
      }

      patchRefresh(packageName, { commits: response.commits });

      setAppended((current) =>
        current.map((item) =>
          item.id === rowId
            ? {
                ...item,
                branch,
                commitSha: response.selected?.commitSha ?? "",
                codeVersion: response.selected?.codeVersion ?? "",
              }
            : item,
        ),
      );
      setPlan(null);
    })();
  }

  function changeAppendCommit(rowId: number, packageName: string, commitSha: string): void {
    setAppended((current) =>
      current.map((item) => (item.id === rowId ? { ...item, commitSha, codeVersion: "…" } : item)),
    );
    setPlan(null);

    void (async () => {
      const response = await readPackageChangelogAction(projectId, packageName, commitSha);

      setAppended((current) =>
        current.map((item) =>
          item.id === rowId
            ? { ...item, codeVersion: response.ok ? response.codeVersion : "读不到代码版本" }
            : item,
        ),
      );
    })();
  }

  function appendRow(): void {
    setAppended((current) => [
      ...current,
      {
        id: (current.at(-1)?.id ?? 0) + 1,
        packageName: "",
        branch: "",
        commitSha: "",
        codeVersion: "",
        customTag: "",
      },
    ]);
    setPlan(null);
  }

  function removeAppendRow(id: number): void {
    setAppended((current) => current.filter((item) => item.id !== id));
    setPlan(null);
  }

  /** 只有真的改过的现有包才进 `replace`。 */
  function replacedPayload() {
    return currentPackages
      .map((item) => ({ item, draft: drafts[item.packageName] }))
      .filter(({ item, draft }) => {
        if (draft === undefined) {
          return false;
        }

        const tag = draft.customTag.trim();

        return (
          draft.branch !== item.branch ||
          draft.commitSha !== item.commitSha ||
          (tag !== "" && tag !== item.releaseVersion)
        );
      })
      .map(({ item, draft }) => ({
        packageName: item.packageName,
        branch: draft.branch,
        commitSha: draft.commitSha,
        customTag: draft.customTag.trim() === "" ? null : draft.customTag.trim(),
      }));
  }

  function appendedPayload() {
    return appended
      .filter((item) => item.packageName !== "" && item.branch !== "" && item.commitSha !== "")
      .map((item) => ({
        packageName: item.packageName,
        branch: item.branch,
        commitSha: item.commitSha,
        customTag: item.customTag.trim() === "" ? null : item.customTag.trim(),
      }));
  }

  async function patch(body: unknown, dryRun: boolean): Promise<Response> {
    return fetch(`/api/releases/${releaseId}/update${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** 第一步：只算不改，把清单摆出来让人确认。 */
  async function preview(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    setResult(null);

    try {
      const response = await patch(
        { append: appendedPayload(), replace: replacedPayload() },
        true,
      );

      if (!response.ok) {
        setError(await readErrorMessage(response, "预览更新失败"));
        return;
      }

      const body = (await response.json()) as { plan: ReleaseUpdatePlan };
      setPlan(body.plan);
    } finally {
      setSubmitting(false);
    }
  }

  /** 第二步：真正执行。 */
  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const response = await patch(
        { append: appendedPayload(), replace: replacedPayload() },
        false,
      );

      if (!response.ok) {
        setError(await readErrorMessage(response, "更新提测失败"));
        return;
      }

      const body = (await response.json()) as UpdateResult & { plan: ReleaseUpdatePlan };

      setResult(body);
      setPlan(null);
      setNotice(
        `提测已更新到第 ${body.revision} 轮：放弃 ${body.abandonedCrpReleaseIds.length} 条旧 Release，` +
          `重投 ${body.redispatchedPackageNames.length} 个软件包。`,
      );

      // 重新渲染服务端页面，新的轮次与留痕立刻可见。
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (locked) {
    return <p>这条提测现在不能改，等上面说明的原因消失后再来。</p>;
  }

  const hasChanges =
    replacedPayload().length > 0 || appendedPayload().length > 0;

  return (
    <>
      <h2>修改已有软件包</h2>
      <p>
        改分支、Commit 或提测版本都会新起一轮快照，并把它依赖链上的下游一起作废重投。
        不改的包不要动，它不会被重投。<br />
        <button
          type="button"
          style={styles.smallButton}
          onClick={() =>
            startRefresh(async () => {
              const response = await refreshProjectPackagesAction(projectId);

              if (!response.ok) {
                setError(response.message);
                return;
              }

              setRefreshes(response.packages);
            })
          }
          disabled={refreshing}
        >
          {refreshing ? "正在从 Gerrit 刷新…" : "从 Gerrit 刷新分支与提交"}
        </button>
      </p>

      {error === null ? null : <p role="alert">操作失败：{error}</p>}
      {notice === null ? null : <p role="status">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>软件包</th>
            <th>分支</th>
            <th>Commit</th>
            <th>提测版本（自定义 Tag）</th>
            <th>改动</th>
          </tr>
        </thead>
        <tbody>
          {currentPackages.map((item) => {
            const draft = drafts[item.packageName];
            const row = refreshedByName.get(item.packageName);
            const changed =
              draft !== undefined &&
              (draft.branch !== item.branch ||
                draft.commitSha !== item.commitSha ||
                (draft.customTag.trim() !== "" && draft.customTag.trim() !== item.releaseVersion));

            return (
              <tr key={item.packageName}>
                <td>
                  {item.packageName}
                  <br />
                  <small>
                    当前：{shortSha(item.commitSha)} / {item.releaseVersion}（
                    {item.snapshotStatus}）
                  </small>
                </td>
                <td>
                  <select
                    style={styles.input}
                    value={draft?.branch ?? ""}
                    onChange={(event) => changeDraftBranch(item.packageName, event.target.value)}
                    disabled={busy === item.packageName || row === undefined}
                  >
                    {(row?.branches ?? []).map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                    {draft === undefined || row?.branches.includes(draft.branch) ? null : (
                      <option value={draft.branch}>{draft.branch}（当前）</option>
                    )}
                  </select>
                </td>
                <td>
                  <select
                    style={styles.input}
                    value={draft?.commitSha ?? ""}
                    onChange={(event) => changeDraftCommit(item.packageName, event.target.value)}
                    disabled={busy === item.packageName || row === undefined}
                  >
                    {(row?.commits ?? []).map((commit) => (
                      <option key={commit.sha} value={commit.sha}>
                        {shortSha(commit.sha)} {commit.summary}
                      </option>
                    ))}
                    {draft === undefined || row?.commits.some((commit) => commit.sha === draft.commitSha) ? null : (
                      <option value={draft.commitSha}>{shortSha(draft.commitSha)}（当前）</option>
                    )}
                  </select>
                </td>
                <td>
                  <input
                    style={styles.input}
                    value={draft?.customTag ?? ""}
                    onChange={(event) => changeDraftTag(item.packageName, event.target.value)}
                    placeholder={`留空保持 ${item.releaseVersion}`}
                  />
                </td>
                <td>{changed ? "已改动" : "未改动"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>追加软件包</h2>
      <p>只能从项目软件清单里挑还没进这次提测的包。已经投递成功的包不会被重投。</p>

      {candidates.length === 0 ? (
        <p>项目清单里没有还能追加的软件包。</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>软件包</th>
                <th>分支</th>
                <th>Commit</th>
                <th>代码版本</th>
                <th>自定义 Tag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {appended.map((item) => {
                const row = refreshedByName.get(item.packageName);

                return (
                  <tr key={item.id}>
                    <td>
                      <select
                        style={styles.input}
                        value={item.packageName}
                        onChange={(event) => selectAppendPackage(item.id, event.target.value)}
                      >
                        <option value="">请选择软件包</option>
                        {candidates.map((candidate) => (
                          <option key={candidate.packageName} value={candidate.packageName}>
                            {candidate.packageName}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        style={styles.input}
                        value={item.branch}
                        onChange={(event) =>
                          changeAppendBranch(item.id, item.packageName, event.target.value)
                        }
                        disabled={item.packageName === "" || row === undefined}
                      >
                        {(row?.branches ?? []).map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        style={styles.input}
                        value={item.commitSha}
                        onChange={(event) =>
                          changeAppendCommit(item.id, item.packageName, event.target.value)
                        }
                        disabled={item.packageName === "" || row === undefined}
                      >
                        {(row?.commits ?? []).map((commit) => (
                          <option key={commit.sha} value={commit.sha}>
                            {shortSha(commit.sha)} {commit.summary}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{item.codeVersion === "" ? "—" : item.codeVersion}</td>
                    <td>
                      <input
                        style={styles.input}
                        value={item.customTag}
                        onChange={(event) =>
                          setAppended((current) =>
                            current.map((rowItem) =>
                              rowItem.id === item.id
                                ? { ...rowItem, customTag: event.target.value }
                                : rowItem,
                            ),
                          )
                        }
                        placeholder="留空用代码版本"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        style={styles.smallButton}
                        onClick={() => removeAppendRow(item.id)}
                      >
                        移除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p>
            <button type="button" style={styles.smallButton} onClick={appendRow}>
              加一行
            </button>
          </p>
        </>
      )}

      <h2>确认</h2>
      <p>
        <button
          type="button"
          style={styles.smallButton}
          onClick={() => void preview()}
          disabled={!hasChanges || submitting}
        >
          {submitting ? "正在计算…" : "预览将放弃与重投的清单"}
        </button>
      </p>

      {plan === null ? null : (
        <div role="status">
          <p>
            这次更新会把提测从第 {plan.revisionBefore} 轮推到第 {plan.revisionAfter} 轮；
            CRP 工作流进度 {plan.workProgress}（{plan.workProgressLabel}）。
          </p>
          <dl>
            <dt>将放弃的 CRP Release</dt>
            <dd>
              {plan.abandoned.length === 0
                ? "没有（没有已投递的旧产物要放弃）"
                : `${plan.abandoned.length} 条：${plan.abandoned
                    .map((item) => `${item.packageName}#${item.crpReleaseId}`)
                    .join("、")}`}
            </dd>
            <dt>将重投的软件包</dt>
            <dd>
              {plan.redispatchedPackageNames.length === 0
                ? "没有"
                : `${plan.redispatchedPackageNames.length} 个：${plan.redispatchedPackageNames.join("、")}`}
            </dd>
            <dt>更新后的投递顺序（上游在前）</dt>
            <dd>
              <code>{plan.order.join(" → ")}</code>
            </dd>
          </dl>
          <p>
            <button
              type="button"
              style={styles.button}
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? "正在更新…" : "确认更新"}
            </button>
          </p>
        </div>
      )}

      {result === null ? null : (
        <dl>
          <dt>更新后的轮次</dt>
          <dd>{result.revision}</dd>
          <dt>放弃的 CRP Release</dt>
          <dd>
            <code>
              {result.abandonedCrpReleaseIds.length === 0
                ? "—"
                : result.abandonedCrpReleaseIds.join("、")}
            </code>
          </dd>
          <dt>重投的软件包</dt>
          <dd>
            <code>
              {result.redispatchedPackageNames.length === 0
                ? "—"
                : result.redispatchedPackageNames.join("、")}
            </code>
          </dd>
          <dt>投递推进</dt>
          <dd>
            {result.advanceError === null
              ? "已推进一次，后续由定时器继续投递。"
              : `更新已提交，但这次推进没成功：${result.advanceError}。定时器会继续推进。`}
          </dd>
        </dl>
      )}
    </>
  );
}
