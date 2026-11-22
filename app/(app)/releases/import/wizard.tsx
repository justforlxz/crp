"use client";

/**
 * 从 CRP 导入已有提测主题的三步向导。
 *
 * 找主题 → 选项目 → 映射预览，全部数据都由 `/api/releases/import` 现取：
 *
 * - 第一步可以输入 Topic ID，也可以在某条基线（CRP 交付分支）下按名称搜；
 * - 第二步选项目经理与其名下项目，主题分支与项目基线不一致的项目不能选；
 * - 第三步先出映射预览，卡住的包标红且不放行，确认后才真正落库。
 *
 * 为什么是客户端组件：三步之间要带着「选了哪个主题、哪个项目、要不要一并加入软件清单」
 * 这些临时状态来回走，服务端每步都重新渲染反而更难读。
 *
 * 服务端仍然是唯一的判定者：这里的禁用只算提示，`POST /api/releases/import` 会再判一次。
 */

import Link from "next/link";
import { useState } from "react";

import type { ReleaseProjectChoice } from "@/lib/releases";

/** 基线下拉里的一项：搜索主题要用它的 CRP 分支 ID。 */
type BaselineOption = {
  id: string;
  crpBranchId: string;
  name: string;
};

/** 第一步显示的主题概要（`GET /api/releases/import` 的返回）。 */
type TopicSummary = {
  id: number;
  name: string;
  branchId: number;
  branchName: string;
  owner: string;
  type: string;
  abandoned: boolean;
  completed: boolean;
  releaseCount: number | null;
  /** Owner 里有没有当前 CRP 账号；按关键字搜（没解析账号）时为 `null`。 */
  mine: boolean | null;
};

/**
 * 第一步列表的返回（`GET /api/releases/import?baselineId=…`）。
 *
 * `total` 是截断前的命中条数，`limit` 是单次上限：两者不一致就要在页面上说清
 * 「只显示前 N 条」，不能让人以为看到的就是全部。
 */
type TopicList = {
  topics: TopicSummary[];
  total: number;
  limit: number;
  truncated: boolean;
  /** 「只看我的主题」用到的当前 CRP 账号；按关键字搜时为 `null`。 */
  currentUser: { name: string; nameCn: string } | null;
};

/** 预览里的一行。字段与 `lib/releases/import.ts` 的 `ImportedPackagePlan` 一致。 */
type PackageRow = {
  packageName: string;
  packageId: string | null;
  repoPath: string;
  branch: string;
  commitSha: string;
  commitSource: "crp" | "gerrit-tag";
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  crpReleaseId: string;
  buildState: string;
  buildStateKnown: boolean;
  buildStateNote: string | null;
  status: string;
  versionMismatch: boolean;
};

type BlockedRow = { packageName: string; reason: string };

type Preview = {
  project: { id: string; key: string; name: string; baselineName: string };
  topic: TopicSummary;
  packages: PackageRow[];
  blocked: BlockedRow[];
  existing: { releaseId: string; version: string; projectName: string } | null;
  ready: boolean;
};

type ImportResult = {
  id: string;
  version: string;
  status: string;
  packageCount: number;
  autoRegisteredPackages: string[];
  addedToProject: string[];
  workProgress: number | null;
  workProgressLabel: string | null;
  workProgressError: string | null;
  locked: boolean;
};

type Step = 1 | 2 | 3;

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** 从错误响应里取一句能显示的话；取不到就给通用提示。 */
async function readError(response: Response): Promise<{ message: string; existingReleaseId: string | null }> {
  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const error = (payload as { error?: { message?: string; details?: { existingReleaseId?: string } } } | null)
    ?.error;

  return {
    message: error?.message ?? `请求失败（HTTP ${response.status}）。`,
    existingReleaseId: error?.details?.existingReleaseId ?? null,
  };
}

export function ImportWizard({
  projects,
  baselines,
  workspaceQuery,
}: {
  projects: ReleaseProjectChoice[];
  baselines: BaselineOption[];
  workspaceQuery: string;
}) {
  const [step, setStep] = useState<Step>(1);
  const [topicIdText, setTopicIdText] = useState("");
  const [baselineId, setBaselineId] = useState(baselines[0]?.id ?? "");
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<TopicSummary[] | null>(null);
  /** 「只看我的主题」：不输关键字，直接列当前 CRP 账号当 Owner 的主题。 */
  const [mineOnly, setMineOnly] = useState(false);
  const [listMeta, setListMeta] = useState<{
    total: number;
    limit: number;
    truncated: boolean;
  } | null>(null);
  const [currentAccount, setCurrentAccount] = useState<{ name: string; nameCn: string } | null>(null);
  const [topic, setTopic] = useState<TopicSummary | null>(null);
  const [managerId, setManagerId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [addPackages, setAddPackages] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [existingReleaseId, setExistingReleaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const managers = [...new Map(projects.map((item) => [item.managerId, item.managerName])).entries()];
  const managerProjects = projects.filter((item) => item.managerId === managerId);
  const project = projects.find((item) => item.id === projectId) ?? null;
  const baselineBranchById = new Map(baselines.map((item) => [item.id, item.crpBranchId]));

  /** 主题分支与项目基线是否一致；一致才能选这个项目。 */
  function baselineMatches(item: ReleaseProjectChoice): boolean {
    if (topic === null) {
      return true;
    }

    return baselineBranchById.get(item.baseline.id) === String(topic.branchId);
  }

  async function readTopicById(): Promise<void> {
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(
        `/api/releases/import?topicId=${encodeURIComponent(topicIdText.trim())}`,
      );

      if (!response.ok) {
        const failure = await readError(response);
        setError(failure.message);
        return;
      }

      const payload = (await response.json()) as { topic: TopicSummary };
      setTopic(payload.topic);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 第一步的列表：`mineOnly` 打开时不带关键字，列出当前 CRP 账号建的主题；否则按关键字搜。
   *
   * 两条路返回同一份结构，截断信息（`total` / `limit`）一起带回来，页面据此提示
   * 「只显示前 N 条」。
   */
  async function loadTopics(): Promise<void> {
    setError(null);
    setBusy(true);

    try {
      const params = new URLSearchParams({ baselineId });

      if (mineOnly) {
        params.set("mine", "1");
      } else {
        params.set("name", keyword.trim());
      }

      const response = await fetch(`/api/releases/import?${params.toString()}`);

      if (!response.ok) {
        const failure = await readError(response);
        setError(failure.message);
        return;
      }

      const payload = (await response.json()) as TopicList;
      setCandidates(payload.topics);
      setListMeta({ total: payload.total, limit: payload.limit, truncated: payload.truncated });
      setCurrentAccount(payload.currentUser);
    } finally {
      setBusy(false);
    }
  }

  async function buildPreview(): Promise<void> {
    if (topic === null || projectId === "") {
      return;
    }

    setError(null);
    setExistingReleaseId(null);
    setBusy(true);

    try {
      const response = await fetch("/api/releases/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          topicId: topic.id,
          mode: "preview",
          addPackagesToProject: addPackages,
        }),
      });

      if (!response.ok) {
        const failure = await readError(response);
        setError(failure.message);
        return;
      }

      setPreview((await response.json()) as Preview);
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (topic === null || projectId === "") {
      return;
    }

    setError(null);
    setExistingReleaseId(null);
    setBusy(true);

    try {
      const response = await fetch("/api/releases/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          topicId: topic.id,
          mode: "commit",
          addPackagesToProject: addPackages,
        }),
      });

      if (!response.ok) {
        const failure = await readError(response);
        setError(failure.message);
        setExistingReleaseId(failure.existingReleaseId);
        return;
      }

      setResult((await response.json()) as ImportResult);
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) {
    return (
      <section className="card card--wide">
        <h2>导入完成</h2>
        <p>
          提测版本 <code>{result.version}</code>，状态 <code>{result.status}</code>，
          共 {result.packageCount} 个包。来源记为「从 CRP 导入」。
        </p>
        <dl>
          <dt>CRP 工作流进度</dt>
          <dd>
            {result.workProgress === null
              ? (result.workProgressError ?? "读不到")
              : `${result.workProgress}（${result.workProgressLabel ?? "未知状态"}）`}
          </dd>
          <dt>自动登记的软件包</dt>
          <dd>
            {result.autoRegisteredPackages.length === 0
              ? "没有（这些包原本都已登记）"
              : result.autoRegisteredPackages.join("、")}
          </dd>
          <dt>一并加入项目软件清单</dt>
          <dd>{result.addedToProject.length === 0 ? "没有" : result.addedToProject.join("、")}</dd>
        </dl>
        {result.locked ? (
          <p className="alert alert--error" role="alert">
            这个主题在 CRP 上已经转测，记录被标记为锁定，「更新提测」不可用。
          </p>
        ) : null}
        <p>
          {/* 详情页属 A13（阶段 10），现在先跳到 A17 的更新页。 */}
          <Link href={`/releases/${result.id}/update${workspaceQuery}`}>查看并更新这条提测</Link>
          {" · "}
          <Link href={`/releases/new${workspaceQuery}`}>回到创建提测</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="card card--wide">
      <h2>从 CRP 导入已有提测主题</h2>
      <p className="hint">
        同事在 CRP 上直接建的主题、以及历史遗留的主题，不必重头再建一次。导入只读 CRP，
        不会建 Topic、不会投递、不会删 Release。
      </p>

      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
          {existingReleaseId === null ? null : (
            <>
              {" "}
              <Link href={`/releases/${existingReleaseId}/update${workspaceQuery}`}>
                查看已有记录
              </Link>
            </>
          )}
        </p>
      )}

      {step === 1 ? (
        <>
          <h2>第一步：找主题</h2>
          <label className="field-label" htmlFor="topic-id">
            输入 Topic ID
          </label>
          <div className="row">
            <input
              id="topic-id"
              className="input"
              value={topicIdText}
              onChange={(event) => setTopicIdText(event.target.value)}
              placeholder="例如 29158"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void readTopicById()}
              disabled={busy || topicIdText.trim() === ""}
            >
              读主题
            </button>
          </div>

          <label className="field-label" htmlFor="topic-baseline">
            基线（CRP 交付分支）：按名称搜索与「只看我的主题」都在这一条分支下找
          </label>
          <div className="row">
            <select
              id="topic-baseline"
              className="input"
              value={baselineId}
              onChange={(event) => {
                setBaselineId(event.target.value);
                setCandidates(null);
                setListMeta(null);
              }}
            >
              {baselines.length === 0 ? <option value="">（还没有基线）</option> : null}
              {baselines.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <p>
            <label>
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(event) => {
                  setMineOnly(event.target.checked);
                  // 换模式就清空上一批结果：否则「我的主题」下面会挂着上次关键字搜出来的别人的主题。
                  setCandidates(null);
                  setListMeta(null);
                }}
              />{" "}
              只看我的主题（当前 CRP 账号当 Owner 的 test 类型主题，不用输关键字）
            </label>
            {currentAccount === null ? null : (
              <span className="hint">
                {" "}
                当前 CRP 账号：
                {currentAccount.nameCn === ""
                  ? currentAccount.name
                  : `${currentAccount.nameCn}（${currentAccount.name}）`}
              </span>
            )}
          </p>

          {mineOnly ? null : (
            <label className="field-label" htmlFor="topic-name">
              主题名关键字
            </label>
          )}
          <div className="row">
            {mineOnly ? null : (
              <input
                id="topic-name"
                className="input"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="主题名的一部分"
              />
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void loadTopics()}
              disabled={busy || baselineId === "" || (!mineOnly && keyword.trim() === "")}
            >
              {mineOnly ? "列出我的主题" : "搜索"}
            </button>
          </div>

          {candidates === null ? null : (
            <>
              {listMeta !== null && listMeta.truncated ? (
                <p className="alert alert--warn" role="status">
                  这条基线下命中 {listMeta.total} 个主题，只显示前 {candidates.length} 条（单次上限{" "}
                  {listMeta.limit} 条）。缩小范围能看全其余部分。
                </p>
              ) : null}

              {candidates.length === 0 ? (
                <p className="hint">
                  {mineOnly
                    ? "这条基线下没有你当 Owner 的 test 类型主题。"
                    : `这条基线下没有名字包含「${keyword}」的 test 类型主题。`}
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Topic ID</th>
                        <th>主题</th>
                        <th>基线分支</th>
                        <th>Owner</th>
                        <th>创建者</th>
                        <th>状态</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <code>{item.id}</code>
                          </td>
                          <td>{item.name}</td>
                          <td>
                            <code>{item.branchName}</code>
                          </td>
                          <td>{item.owner === "" ? "—" : item.owner}</td>
                          <td>{item.mine === null ? "—" : item.mine ? "本人" : "他人"}</td>
                          <td>
                            {item.abandoned ? "已放弃" : item.completed ? "已完成" : "进行中"}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setTopic(item)}
                            >
                              选这个
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {topic === null ? null : (
            <div className="section">
              <h3>已选主题</h3>
              <dl>
                <dt>名称</dt>
                <dd>
                  {topic.name}（ID {topic.id}）
                </dd>
                <dt>基线分支</dt>
                <dd>
                  <code>{topic.branchName}</code>（ID {topic.branchId}）
                </dd>
                <dt>Owner</dt>
                <dd>{topic.owner === "" ? "—" : topic.owner}</dd>
                <dt>类型与状态</dt>
                <dd>
                  {topic.type}
                  {topic.abandoned ? " · 已放弃" : topic.completed ? " · 已完成" : " · 进行中"}
                </dd>
                <dt>Release 数量</dt>
                <dd>{topic.releaseCount === null ? "—" : topic.releaseCount}</dd>
              </dl>
              <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
                下一步：选项目
              </button>
            </div>
          )}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h2>第二步：选项目</h2>
          <p className="hint">
            提测要挂在一个项目上。主题所在的 CRP 分支必须与项目基线一致，不一致的项目不能选。
          </p>

          <label className="field-label" htmlFor="manager">
            项目经理
          </label>
          <select
            id="manager"
            className="input"
            value={managerId}
            onChange={(event) => {
              setManagerId(event.target.value);
              setProjectId("");
              setPreview(null);
            }}
          >
            <option value="">请选择</option>
            {managers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>

          <label className="field-label" htmlFor="project">
            项目
          </label>
          <select
            id="project"
            className="input"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setPreview(null);
            }}
            disabled={managerId === ""}
          >
            <option value="">请选择</option>
            {managerProjects.map((item) => (
              <option key={item.id} value={item.id} disabled={!baselineMatches(item)}>
                {item.name}（{item.key}）· 基线 {item.baseline.name}
                {baselineMatches(item) ? "" : " · 与主题分支不一致"}
              </option>
            ))}
          </select>

          {projectId === "" ? null : project === null ? null : (
            <p className="hint">
              基线 {project.baseline.name}（{project.baseline.stateLabel}）· 清单 {project.packageCount}{" "}
              个软件包
              {project.ready ? "" : " · 这个项目本身还不能创建提测，但导入不建 Topic，仍可继续"}
            </p>
          )}

          <p>
            <label>
              <input
                type="checkbox"
                checked={addPackages}
                onChange={(event) => setAddPackages(event.target.checked)}
              />{" "}
              一并加入项目软件清单（默认不勾）
            </label>
          </p>
          <p className="hint">
            不勾也照样导入：主题里的包会进提测快照，但项目清单保持原样。
          </p>

          <p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep(1)}>
              上一步
            </button>{" "}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setStep(3);
                void buildPreview();
              }}
              disabled={projectId === "" || busy}
            >
              下一步：映射预览
            </button>
          </p>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <h2>第三步：映射预览</h2>

          {busy && preview === null ? <p>正在读 CRP 与 Gerrit…</p> : null}

          {preview === null ? null : (
            <>
              <p>
                主题「{preview.topic.name}」→ 项目「{preview.project.name}」（基线{" "}
                {preview.project.baselineName}）
              </p>

              {preview.existing === null ? null : (
                <p role="alert" className="alert alert--error">
                  这个主题已经导入到项目「{preview.existing.projectName}」（提测版本{" "}
                  {preview.existing.version}），同一个主题只能导入一次。{" "}
                  <Link href={`/releases/${preview.existing.releaseId}/update${workspaceQuery}`}>
                    查看已有记录
                  </Link>
                </p>
              )}

              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>软件包</th>
                      <th>分支</th>
                      <th>提测版本（CRP tag）</th>
                      <th>CRP 构建状态</th>
                      <th>Commit</th>
                      <th>代码版本</th>
                      <th>基线仓库版本</th>
                      <th>快照状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.packages.map((item) => (
                      <tr key={item.packageName}>
                        <td>
                          {item.packageName}
                          <br />
                          <small>
                            {item.repoPath}
                            {item.packageId === null ? " · 将自动登记软件包" : ""}
                          </small>
                        </td>
                        <td>
                          <code>{item.branch}</code>
                        </td>
                        <td>{item.releaseVersion}</td>
                        <td>
                          <code>{item.buildState}</code>
                          {item.buildStateKnown ? null : (
                            <div>
                              <small role="alert">{item.buildStateNote}</small>
                            </div>
                          )}
                        </td>
                        <td>
                          <code>{shortSha(item.commitSha)}</code>
                          <br />
                          <small>{item.commitSource === "crp" ? "取自 CRP" : "按 Tag 反查"}</small>
                        </td>
                        <td>
                          {item.codeVersion}
                          {item.versionMismatch ? (
                            <div>
                              <small role="status">与提测版本不同（往往正是要改包的原因）</small>
                            </div>
                          ) : null}
                        </td>
                        <td>{item.repoVersion ?? "—"}</td>
                        <td>
                          <code>{item.status}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.blocked.length === 0 ? null : (
                <div className="alert alert--error" role="alert">
                  <p>这些包还不能导入，整次导入停在预览：</p>
                  <ul>
                    {preview.blocked.map((item) => (
                      <li key={item.packageName}>
                        {item.packageName}：{item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep(2)}>
                  上一步
                </button>{" "}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void commit()}
                  disabled={!preview.ready || busy}
                >
                  {busy ? "导入中…" : "确认导入"}
                </button>
              </p>
            </>
          )}

          {preview === null && !busy ? (
            <p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void buildPreview()}>
                重新生成预览
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
