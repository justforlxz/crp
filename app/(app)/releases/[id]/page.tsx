/**
 * 提测详情（A13）。
 *
 * 一条提测的来龙去脉都在这页：概要条（版本、基线、软件数、创建人、说明、来源）、
 * 构建状态区块（A14 的组件，这一页只负责挂上去）、「更新提测」入口、
 * 状态流转与活动记录、软件包提交快照表、CRP 仓库记录关联、项目概要、提测信息。
 *
 * 结构与 class 名来自 `.agents/spec/design/prototype.html` 的提测详情（MKACG-970 的模块移植）：
 * `.card panel` + `.summary-strip` + 4 个 `.summary-cell`、`.table-scroll` 表格、
 * `.project-card`（`.project-card-top` / `.project-meta` / `.project-software-chips`）、
 * `.timeline` + `.tl-item` + `.tl-dot` + `.tl-content`、`.risk-box`（条件）、`.tip`。
 * 原型里没有的模块不在这里另造：模块样式由 MKACG-969 统一提供，这一页只挂 class。
 *
 * 两条硬约束落在页面上：
 *
 * - 快照表只读（MUST NOT）：这里没有任何改快照的入口，唯一的变更路径是「更新提测」，
 *   它走 A17 的追加轮次；
 * - 「更新提测」在转测之后置灰并给出原因（AC5）：原因是 A17 判定的同一句话，
 *   页面不解自己的版本。同一句话也进 `.risk-box` —— 页面上「现在改不了」的原因只有一处来源。
 *
 * `.risk-box` 只在真有问题时渲染（AC4）：有软件包没构建通过，或者这条提测现在改不了。
 * 包为 0、没有构建记录的提测不会出现空壳。
 *
 * 跨工作区一律 404：按 id 直接查库，所以这一处判断就是跨工作区读取的唯一关口。
 */
import Link from "next/link";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { findReleaseScope } from "@/lib/build";
import { getProject } from "@/lib/projects";
import {
  abandonTopicLockReason,
  cancelReleaseLockReason,
  canViewRelease,
  loadCancelableReleaseCount,
  loadCrpTopicName,
  loadReleaseDetail,
  ReleaseError,
  releaseSourceLabel,
  releaseStatusLabel,
  releaseStatusPillClass,
  SNAPSHOT_COLUMNS,
  snapshotRowCells,
} from "@/lib/releases";
import { resolveWorkspaceScope } from "../../workspaceScope";
import { AbandonTopicForm } from "./abandonTopicForm";
import {
  abandonTopicAction,
  cancelReleaseAction,
  refreshRepositoryRecordsAction,
} from "./actions";
import { BuildStatusSection } from "./buildStatusSection";
import { CancelReleaseForm } from "./cancelReleaseForm";
import { CopyValue } from "./copyValue";
import { buildRiskItems, buildTimeline, formatTime } from "./detailView";

// CRP 进度与构建状态一直在变，页面不做静态化。
export const dynamic = "force-dynamic";

/** 标识符列（版本号、提交号）用等宽字体显示，认的是列名而不是下标：列顺序变了也不会串行。 */
const CODE_COLUMNS = new Set([
  "代码版本",
  "基线仓库版本",
  "本次提测版本",
  "基线 Commit",
  "本次 Commit",
]);

/** 项目卡里的软件包清单最多显示几个，超出用「+N」收口（与原型一致）。 */
const PROJECT_CHIP_LIMIT = 7;

type ReleaseDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

export default async function ReleaseDetailPage({
  params,
  searchParams,
}: ReleaseDetailPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const scope = await resolveWorkspaceScope(`/releases/${id}`, query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="提测详情">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const owner = await findReleaseScope(id);

  // 提测不存在、账号不属于任何工作区、提测在别的工作区，一律 404。
  if (
    !canViewRelease({
      release: owner === null ? null : { workspaceId: owner.workspaceId },
      activeWorkspaceId: scope.active.id,
    })
  ) {
    notFound();
  }

  let detail: Awaited<ReturnType<typeof loadReleaseDetail>>;

  try {
    detail = await loadReleaseDetail(id);
  } catch (error) {
    if (error instanceof ReleaseError) {
      return (
        <PageShell title="提测详情">
          <p className="alert alert--error" role="alert">{error.message}</p>
          <p>
            <Link href={`/releases${scope.query}`}>回到提测记录列表</Link>
          </p>
        </PageShell>
      );
    }

    throw error;
  }

  // 项目卡要的「负责人」与软件包依赖只在项目记录里：一处补齐，不改提测的读取逻辑。
  // 软删的项目也要能查（历史提测指向它），否则项目卡会整块消失。
  const project = await getProject(detail.project.id, { includeDeleted: true });
  const upstreamByName = new Map(
    (project?.softwareRows ?? []).map((row) => [row.packageName, row.upstreamNames.length]),
  );
  const dependencyCount = (project?.softwareRows ?? []).reduce(
    (total, row) => total + row.upstreamNames.length,
    0,
  );

  const commitErrors = detail.packages.filter((item) => item.commitError !== null);
  // 危险操作按来源只显示一个：平台创建的走「取消提测」，从 CRP 导入的才显示「放弃提测主题」。
  // 能不能点、不能点时为什么，两个分支各只有一个纯函数判定，页面与服务端用的是同一份。
  const abandonLockReason = abandonTopicLockReason(detail);
  const cancelLockReason = cancelReleaseLockReason(detail);
  // 只有真的要渲染确认框时才有下面两次读取：别的读路径（例如导出 CSV）不必付这次往返与这条查询。
  const needDangerConfirmation =
    detail.source === "imported" ? abandonLockReason === null : cancelLockReason === null;
  // 确认框要写明主题名；读不到就退回本地记录的提测版本。
  const dangerTopicName = needDangerConfirmation
    ? await loadCrpTopicName(detail.crpTopicId, undefined)
    : null;
  // 取消提测会逐个删 Release，确认框必须写清删几条；口径与 cancelRelease 一致，只数当前轮。
  const cancelReleaseCount =
    needDangerConfirmation && detail.source !== "imported"
      ? await loadCancelableReleaseCount(detail.releaseId)
      : 0;

  // 时间线与风险提示的判定都在 `detailView.ts` 里（纯函数，单测直接喂数据）。
  const timeline = buildTimeline(detail);
  const riskItems = buildRiskItems(detail);

  return (
    <PageShell
      title="提测详情"
      actions={
        <a className="btn primary" href={`/api/releases/${detail.releaseId}/export`}>
          导出提测单
        </a>
      }
    >
      <p>
        <Link href={`/releases${scope.query}`}>提测记录列表</Link>
        {"　"}
        <Link href={`/projects/${detail.project.id}${scope.query}`}>
          {detail.project.name}（{detail.project.key}）
        </Link>
      </p>

      {query.error === undefined ? null : (
        <p className="alert alert--error" role="alert">
          操作失败：{query.error}
        </p>
      )}
      {query.notice === undefined ? null : (
        <p className="alert alert--info" role="status">
          {query.notice}
        </p>
      )}

      <div className="card panel" data-style-anchor="release-detail.summary">
        <div className="summary-strip">
          <div className="summary-cell">
            <small>CRP 提测版本</small>
            <b className="mono">{detail.version}</b>
            <div className="secondary">
              第 {detail.revision} 轮{"　"}
              <span className={releaseStatusPillClass(detail.status)}>
                {releaseStatusLabel(detail.status)}
              </span>
            </div>
          </div>
          <div className="summary-cell">
            <small>CRP 系统仓库基线</small>
            <b className="mono">{detail.project.baselineName}</b>
            <div className="secondary">{detail.project.name}（{detail.project.key}）</div>
          </div>
          <div className="summary-cell">
            <small>软件包数量</small>
            <b>{detail.packages.length} 个</b>
            <div className="secondary">
              {dependencyCount === 0 ? "清单内无依赖" : `清单内依赖 ${dependencyCount} 条`}
            </div>
          </div>
          <div className="summary-cell">
            <small>提测创建人</small>
            <b>{detail.createdByName}</b>
            <div className="secondary">{formatTime(detail.createdAt)}</div>
          </div>
        </div>
        <div className="small-note">
          提测说明：
          {detail.description === null || detail.description === "" ? "—" : detail.description}
        </div>
        <div className="small-note">
          来源：{releaseSourceLabel(detail.source)}
          {detail.source === "imported" && detail.crpTopicUrl !== null ? (
            <>
              {"　"}
              <a href={detail.crpTopicUrl} target="_blank" rel="noreferrer">
                在原 CRP Topic 里查看
              </a>
            </>
          ) : null}
        </div>
      </div>

      {/* 构建状态区块（A14）：数据由服务端定时轮询写进库里，这一块只读。 */}
      <div className="card panel section-gap">
        <BuildStatusSection releaseId={detail.releaseId} />
      </div>

      <div className="card panel section-gap">
        <div className="panel-head">
          <div>
            <h3>CRP 仓库记录关联</h3>
            <div className="sub">
              提测创建后从 CRP 查询并关联本次软件包对应的仓库记录，支持手动刷新。最近一次同步：
              {formatTime(detail.repositorySyncedAt)}
            </div>
          </div>
          <form action={refreshRepositoryRecordsAction}>
            <input type="hidden" name="releaseId" value={detail.releaseId} />
            <button type="submit" className="btn btn-secondary">⟳ 刷新 CRP 仓库记录</button>
          </form>
        </div>
        {detail.repositoryRecords.length === 0 ? (
          <div className="empty">这些软件包还没投递到 CRP，所以还没有仓库记录。</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-style-anchor="release-detail.repo-records-table">
              <thead>
                <tr>
                  <th>软件包</th>
                  <th>CRP Release ID</th>
                  <th>CRP Build ID</th>
                  <th>CRP 状态</th>
                  <th>CRP 实际 Tag</th>
                  <th>仓库地址</th>
                  <th>最近同步</th>
                </tr>
              </thead>
              <tbody>
                {detail.repositoryRecords.map((row) => (
                  <tr key={row.crpReleaseId}>
                    <td>{row.packageName}</td>
                    <td>
                      <code>{row.crpReleaseId}</code>
                    </td>
                    <td>{row.crpBuildId === null ? "—" : <code>{row.crpBuildId}</code>}</td>
                    <td>{row.crpStatusName ?? "—"}</td>
                    <td
                      title={
                        row.crpBaseTag === null
                          ? undefined
                          : `CRP 记录的 BaseTag 是 ${row.crpBaseTag}`
                      }
                    >
                      {row.crpTag === null ? "—" : <code>{row.crpTag}</code>}
                    </td>
                    <td>{row.repositoryUrl === null ? "—" : <code>{row.repositoryUrl}</code>}</td>
                    <td>{formatTime(row.lastSyncedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tip">
          <div className="tip-icon" aria-hidden="true">ⓘ</div>
          <div>
            <b>「CRP 实际 Tag」是我们提交的版本号之外的东西</b>
            <p>
              它是 CRP 自己记录的版本号，可能与「本次提测版本」不同：实测它会把末位数字加一
              （提交 <code>5.16.20</code> 记成 <code>5.16.21</code>）、追加序号（
              <code>5.7.20</code> 记成 <code>5.7.20.2</code>），或带{" "}
              <code>+uploadcrp</code>、<code>+testbug260209</code> 这样的后缀，具体以 CRP 上显示的值为准。
              提测版本仍按我们提交的值显示与导出，不改写；这一列要等到一次同步之后才有值。
            </p>
          </div>
        </div>
      </div>

      <div className="grid two-col section-gap">
        <div className="card panel">
          <div className="section-title">
            <b>软件包提交快照</b>
            <small>创建提测时固化，后续仓库版本变化不影响此处记录</small>
          </div>
          <div className="small-note">
            共 {detail.packages.length} 个软件包，按依赖顺序排列（上游在前），表格顺序就是本次向
            CRP 提交的软件包顺序。这张表只读；要改只能走「更新提测」，改出来的结果是新一轮快照，
            历史轮次不动。「导出提测单」的列与这张表一致，行数与软件包数一致。
          </div>
          {commitErrors.length === 0 ? null : (
            <div className="tip">
              <div className="tip-icon" aria-hidden="true">✎</div>
              <div>
                <b>提交说明与提交人读不到 Gerrit</b>
                <p>
                  这几行留空：{commitErrors.map((item) => item.packageName).join("、")}。
                  其余列不受影响。
                </p>
              </div>
            </div>
          )}
          <div
            className="table-scroll table-scroll--bounded"
            data-style-anchor="release-detail.snapshot-table-scroll"
          >
            <table className="data-table" data-style-anchor="release-detail.snapshot-table">
              <thead>
                <tr>
                  {SNAPSHOT_COLUMNS.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.packages.map((item, index) => {
                  const cells = snapshotRowCells(item, index + 1);

                  return (
                    <tr key={item.packageName}>
                      {cells.map((cell, cellIndex) => (
                        <td
                          key={`${item.packageName}-${SNAPSHOT_COLUMNS[cellIndex]}`}
                          title={cell}
                        >
                          {CODE_COLUMNS.has(SNAPSHOT_COLUMNS[cellIndex] ?? "") ? (
                            <code>{cell}</code>
                          ) : (
                            cell
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="tip">
            <div className="tip-icon" aria-hidden="true">◉</div>
            <div>
              <b>提测快照已固化</b>
              <p>
                每个软件包分别保存分支、Commit、changelog 代码版本、提交给 CRP 的仓库版本，以及
                自定义 Tag 是否启用和具体值。提测快照可用于后续审计和版本追踪。
              </p>
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="card panel" data-style-anchor="release-detail.update-entry">
            <div className="section-title">
              <b>更新提测</b>
              <small>补包、换包走更新页</small>
            </div>
            {detail.lockReason === null ? (
              <p>
                <Link className="text-link" href={`/releases/${detail.releaseId}/update${scope.query}`}>
                  去更新提测 →
                </Link>
                {"　"}
                补包、换包的流程在更新页里；这里不改任何快照。
              </p>
            ) : (
              <p>
                <button type="button" className="btn btn-secondary" disabled>
                  更新提测
                </button>
                {"　"}
                <span role="status">现在不能更新：{detail.lockReason}</span>
              </p>
            )}
          </div>

          <div className="card project-card" data-style-anchor="release-detail.project-card">
            <div className="project-card-top">
              <div className="project-icon" aria-hidden="true">
                {detail.project.name.slice(0, 1)}
              </div>
              <div>
                <h3>{detail.project.name}</h3>
                <p>
                  {detail.project.key} · {detail.project.baselineName}
                </p>
              </div>
              <div className="project-actions">
                <Link className="text-link" href={`/projects/${detail.project.id}${scope.query}`}>
                  项目配置 →
                </Link>
              </div>
            </div>
            <div className="manager">
              负责人：<b>{project === null ? "—" : project.manager.name}</b>
            </div>
            <div className="project-meta">
              <span>
                CRP 提测基线<b className="mono">{detail.project.baselineName}</b>
              </span>
              <span>
                本次提测软件包<b>{detail.packages.length} 个</b>
              </span>
              <span>
                清单内依赖<b>{dependencyCount} 条</b>
              </span>
            </div>
            <div className="project-software-chips">
              {detail.packages.length === 0 ? (
                <span className="small-note">这次提测还没有软件包</span>
              ) : (
                <>
                  {detail.packages.slice(0, PROJECT_CHIP_LIMIT).map((item, index) => {
                    const deps = upstreamByName.get(item.packageName) ?? 0;

                    return (
                      <span key={item.packageName}>
                        <i>{index + 1}</i>
                        {item.packageName}
                        <small>{deps === 0 ? "无依赖" : `依赖 ${deps} 项`}</small>
                      </span>
                    );
                  })}
                  {detail.packages.length > PROJECT_CHIP_LIMIT ? (
                    <span className="more-chip">+{detail.packages.length - PROJECT_CHIP_LIMIT}</span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className="card panel">
            <div className="panel-head">
              <div>
                <h3>提测信息</h3>
                <div className="sub">CRP 侧的 Topic 与工作流进度</div>
              </div>
            </div>
            <dl data-style-anchor="release-detail.crp-info">
              <dt>CRP Topic ID</dt>
              <dd>
                {detail.crpTopicId === null ? (
                  "还没有建 Topic（尚未投递）"
                ) : (
                  <>
                    <code>{detail.crpTopicId}</code>
                    {"　"}
                    <CopyValue value={detail.crpTopicId} label="复制 Topic ID" />
                  </>
                )}
              </dd>
              <dt>Topic 地址</dt>
              <dd>
                {detail.crpTopicUrl === null ? (
                  "还没有建 Topic（尚未投递）"
                ) : (
                  <>
                    <a href={detail.crpTopicUrl} target="_blank" rel="noreferrer">
                      <code>{detail.crpTopicUrl}</code>
                    </a>
                    {"　"}
                    <CopyValue value={detail.crpTopicUrl} label="复制 Topic 地址" />
                  </>
                )}
              </dd>
              <dt>Topic 状态</dt>
              <dd>
                {detail.crpTopicId === null
                  ? "—"
                  : [
                      detail.crpTopicState === null ? "状态未知" : `State=${detail.crpTopicState}`,
                      detail.crpTopicCompleted === null
                        ? null
                        : detail.crpTopicCompleted
                          ? "已完成"
                          : "未完成",
                      detail.crpTopicAbandoned === null
                        ? null
                        : detail.crpTopicAbandoned
                          ? "已放弃"
                          : "未放弃",
                    ]
                      .filter((item) => item !== null)
                      .join(" · ")}
              </dd>
              <dt>CRP 工作流进度</dt>
              <dd>
                {detail.workProgress === null
                  ? (detail.workProgressError ?? "读不到")
                  : `${detail.workProgress}（${detail.workProgressLabel ?? "未知状态"}）`}
              </dd>
              <dt>工作流进度最近同步</dt>
              <dd>{formatTime(detail.workProgressSyncedAt)}</dd>
            </dl>
          </div>

          <div className="card panel">
            <div className="section-title">
              <b>状态流转与活动记录</b>
              <small>最新在上面，一条记录一行</small>
            </div>
            <div className="timeline" data-style-anchor="release-detail.timeline">
              {timeline.map((entry) => (
                <div className="tl-item" key={entry.key}>
                  <i className={entry.dotClass} aria-hidden="true" />
                  <div className="tl-content">
                    <b>{entry.title}</b>
                    <small>{entry.meta}</small>
                    {entry.notes.map((note) => (
                      <small key={note}>{note}</small>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {riskItems.length === 0 ? null : (
        <div className="risk-box section-gap" data-style-anchor="release-detail.risk-box">
          {riskItems.map((item) => (
            <div key={item.key}>
              <b>{item.title}</b>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      )}

      <section className="danger-zone" data-style-anchor="release-detail.danger-zone">
        <h2>危险操作</h2>
        {detail.source === "imported" ? (
          <>
            <p>
              「放弃提测主题」把 CRP 上的这个 Topic 标记为「已放弃」，用来就地清理演练与验收留下的主题。
              它与投递页的「取消提测」是两个动作：放弃主题一条 Release 都不删，也不改任何快照；
              取消提测才会逐个删 Release。
            </p>
            <p>
              放弃之后不能撤销，CRP 上也不会再接受往这个主题里投递。已经转测（CRP 工作流进度 ≥ 20）的
              主题不能放弃，服务端会再判一次，不只靠这里的禁用。
            </p>
            {abandonLockReason === null ? (
              <AbandonTopicForm
                releaseId={detail.releaseId}
                topicId={detail.crpTopicId ?? ""}
                topicName={dangerTopicName ?? detail.version}
                packageCount={detail.packages.length}
                hasCrpReleases={detail.repositoryRecords.length > 0}
                action={abandonTopicAction}
              />
            ) : (
              <p>
                <button type="button" className="btn btn-danger-outline" disabled>
                  放弃提测主题
                </button>
                {"　"}
                <span role="status">{abandonLockReason}</span>
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              这条提测是在平台上创建的，它自己的 Release 要连同主题一起清理，走「取消提测」。
              「放弃提测主题」只用于从 CRP 导入的提测：导入主题里的 Release 是别人投的，不能删。
            </p>
            {/* 与上面那一支互斥：平台创建的提测不显示「放弃提测主题」，只显示「取消提测」。 */}
            {cancelLockReason === null ? (
              <CancelReleaseForm
                releaseId={detail.releaseId}
                topicId={detail.crpTopicId}
                topicName={dangerTopicName ?? detail.version}
                releaseCount={cancelReleaseCount}
                action={cancelReleaseAction}
              />
            ) : (
              <p>
                <button type="button" className="btn btn-danger-outline" disabled>
                  取消提测
                </button>
                {"　"}
                <span role="status">{cancelLockReason}</span>
              </p>
            )}
          </>
        )}
      </section>
    </PageShell>
  );
}
