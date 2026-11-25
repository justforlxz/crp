/**
 * 提测详情（A13 / MKACG-984 按原型重做）。
 *
 * 结构照 `.agents/spec/design/prototype.html` 的提测详情与 `design.md` 第七节：
 *
 *   `.summary-strip`（4 个 `.summary-cell`，依次是提测记录、状态、基线、CRP 主题）
 *   → 仓库记录 `.panel` + `table.grid`
 *   → 软件包快照 `.panel` + `table.grid`
 *   → 构建状态 `.panel`
 *   → `.detail-cols` 双栏（左「提测信息」用 `.project-card` 结构，右「状态时间线」用
 *     `.risk`（条件）+ `.timeline`）
 *   → `.tip`
 *   → 危险操作 `.panel`
 *
 * 这一页只挂 class，不写样式、不写内联 `style`：样式表由 MKACG-983 按原型重写。
 *
 * 两条硬约束落在页面上：
 *
 * - 快照表只读（MUST NOT）：这里没有任何改快照的入口，唯一的变更路径是「更新提测」，
 *   它走 A17 的追加轮次；
 * - 「更新提测」在转测之后置灰并给出原因（AC5）：原因是 A17 判定的同一句话，
 *   页面不解自己的版本。同一句话也进 `.risk` —— 页面上「现在改不了」的原因只有一处来源。
 *
 * `.risk` 只在真有问题时渲染（FUNC-08）：有软件包没构建通过，或者这条提测现在改不了。
 * 包为 0、没有构建记录的提测不会出现空壳。
 *
 * 跨工作区一律 404：按 id 直接查库，所以这一处判断就是跨工作区读取的唯一关口。
 */
import Link from "next/link";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
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
import { buildRiskItems, buildTimeline, formatTime, statusDotTone } from "./detailView";

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
          <div className="risk" role="alert">
            <span aria-hidden="true">⚠</span>
            <div>{error.message}</div>
          </div>
          <p>
            <Link href={`/releases${scope.query}`}>回到提测记录列表</Link>
          </p>
        </PageShell>
      );
    }

    throw error;
  }

  // 提测信息卡要的「项目经理」与软件包依赖只在项目记录里：一处补齐，不改提测的读取逻辑。
  // 软删的项目也要能查（历史提测指向它），否则卡片的负责人会整块消失。
  const project = await getProject(detail.project.id, { includeDeleted: true });
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
  const statusLabel = releaseStatusLabel(detail.status);

  return (
    <PageShell
      title="提测详情"
      actions={
        <a className="btn btn-primary" href={`/api/releases/${detail.releaseId}/export`}>
          导出提测单
        </a>
      }
    >
      <div className="stack">
        <div className="toast-stack">
          <Toast
            className="toast bad"
            role="alert"
            message={query.error === undefined ? null : `操作失败：${query.error}`}
          />
          <Toast
            className="toast ok"
            message={query.notice === undefined ? null : query.notice}
          />
        </div>

        <dl className="summary-strip" data-style-anchor="release-detail.summary">
          <div className="summary-cell">
            <dt>提测记录</dt>
            <dd>
              <span className="num">{detail.version}</span>
              <small> · {detail.project.name}</small>
            </dd>
          </div>
          <div className="summary-cell">
            <dt>状态</dt>
            <dd>
              <span className={`dot ${statusDotTone(detail.status)}`}>{statusLabel}</span>
              <small> 第 {detail.revision} 轮</small>
            </dd>
          </div>
          <div className="summary-cell">
            <dt>基线</dt>
            <dd>
              <span className="num">{detail.project.baselineName}</span>
            </dd>
          </div>
          <div className="summary-cell">
            <dt>CRP 主题</dt>
            <dd>
              {detail.crpTopicId === null ? (
                <small>还没有建主题（尚未投递）</small>
              ) : (
                <span className="num">#{detail.crpTopicId}</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="panel">
          <div className="panel-hd">
            <h2>仓库记录</h2>
            <span className="hint">每个软件包在当前提测里对应一条，最近一次同步：{formatTime(detail.repositorySyncedAt)}</span>
            <div className="spacer" />
            <form action={refreshRepositoryRecordsAction}>
              <input type="hidden" name="releaseId" value={detail.releaseId} />
              <button type="submit" className="btn btn-sm">刷新</button>
            </form>
          </div>
          {detail.repositoryRecords.length === 0 ? (
            <div className="panel-bd">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">还没有仓库记录</div>
                <div className="empty-d">这些软件包还没投递到 CRP，所以还没有仓库记录。</div>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll">
              <table className="grid" data-style-anchor="release-detail.repo-records-table">
                <thead>
                  <tr>
                    <th>软件包</th>
                    <th>仓库</th>
                    <th>CRP Release</th>
                    <th>构建</th>
                    <th>CRP 状态</th>
                    <th>实际 Tag</th>
                    <th>最近同步</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.repositoryRecords.map((row) => (
                    <tr key={row.crpReleaseId}>
                      <td>
                        <strong>{row.packageName}</strong>
                      </td>
                      <td className="col-mono">{row.repositoryUrl ?? "—"}</td>
                      <td className="col-mono">{row.crpReleaseId}</td>
                      <td className="col-mono">{row.crpBuildId ?? "—"}</td>
                      <td>{row.crpStatusName ?? "—"}</td>
                      <td
                        className="col-mono"
                        title={
                          row.crpBaseTag === null
                            ? undefined
                            : `CRP 记录的 BaseTag 是 ${row.crpBaseTag}`
                        }
                      >
                        {row.crpTag ?? "—"}
                      </td>
                      <td className="num">{formatTime(row.lastSyncedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-bd">
            <div className="tip">
              <span aria-hidden="true">ⓘ</span>
              <div>
                <b>「实际 Tag」是我们提交的版本号之外的东西</b>
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
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>软件包快照</h2>
            <span className="hint">基线版本与本次提交，按依赖顺序排列（上游在前）</span>
          </div>
          <div
            className="panel-bd flush table-scroll"
            data-style-anchor="release-detail.snapshot-table-scroll"
          >
            <table className="grid" data-style-anchor="release-detail.snapshot-table">
              <thead>
                <tr>
                  {SNAPSHOT_COLUMNS.map((column) => (
                    <th key={column} className={column === "提交顺序" ? "num" : undefined}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.packages.map((item, index) => {
                  const cells = snapshotRowCells(item, index + 1);

                  return (
                    <tr key={item.packageName}>
                      {cells.map((cell, cellIndex) => {
                        const column = SNAPSHOT_COLUMNS[cellIndex] ?? "";

                        return (
                          <td
                            key={`${item.packageName}-${column}`}
                            className={
                              column === "提交顺序"
                                ? "num"
                                : CODE_COLUMNS.has(column)
                                  ? "col-mono"
                                  : undefined
                            }
                            title={cell}
                          >
                            {cell}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-bd">
            <p>
              这张表只读；要改只能走「更新提测」，改出来的结果是新一轮快照，历史轮次不动。
              「导出提测单」的列与这张表一致，行数与软件包数一致。
            </p>
            {commitErrors.length === 0 ? null : (
              <div className="tip">
                <span aria-hidden="true">✎</span>
                <div>
                  <b>提交说明与提交人读不到 Gerrit</b>
                  <p>
                    这几行留空：{commitErrors.map((item) => item.packageName).join("、")}。
                    其余列不受影响。
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 构建状态区块（A14）：组件自己渲染 `.panel`（标题、说明、表格都在里面），
            页面只留这一行挂载 —— 外面再套一层会变成面板套面板。 */}
        <BuildStatusSection releaseId={detail.releaseId} />

        <div className="detail-cols">
          <div className="panel">
            <div className="panel-hd">
              <h2>提测信息</h2>
              <span className="hint">项目、负责人与 CRP 侧的进度</span>
            </div>
            <div className="panel-bd flush">
              <div className="project-card" data-style-anchor="release-detail.project-card">
                <div className="pc-hd">
                  <div className="pc-ico" aria-hidden="true">
                    {detail.project.name.slice(0, 1)}
                  </div>
                  <div className="pc-title">
                    <div className="pc-name">{detail.project.name}</div>
                    <div className="pc-key">{detail.project.key}</div>
                  </div>
                </div>
                <div className="pc-body">
                  <dl className="pc-facts">
                    <div className="pc-fact">
                      <dt>项目经理</dt>
                      <dd>{project === null ? "—" : project.manager.name}</dd>
                    </div>
                    <div className="pc-fact">
                      <dt>软件包</dt>
                      <dd className="num">{detail.packages.length}</dd>
                    </div>
                    <div className="pc-fact">
                      <dt>创建人</dt>
                      <dd>{detail.createdByName}</dd>
                    </div>
                  </dl>
                  <dl className="pc-facts">
                    <div className="pc-fact">
                      <dt>清单内依赖</dt>
                      <dd className="num">{dependencyCount}</dd>
                    </div>
                    <div className="pc-fact">
                      <dt>来源</dt>
                      <dd>{releaseSourceLabel(detail.source)}</dd>
                    </div>
                    <div className="pc-fact">
                      <dt>创建时间</dt>
                      <dd className="num">{formatTime(detail.createdAt)}</dd>
                    </div>
                  </dl>
                  <p>
                    <b>提测说明</b>：
                    {detail.description === null || detail.description === ""
                      ? "—"
                      : detail.description}
                  </p>
                  <p data-style-anchor="release-detail.crp-info">
                    <b>CRP 主题</b>：
                    {detail.crpTopicId === null ? (
                      "还没有建 Topic（尚未投递）"
                    ) : (
                      <>
                        <code>{detail.crpTopicId}</code>
                        {"　"}
                        <CopyValue value={detail.crpTopicId} label="复制 Topic ID" />
                      </>
                    )}
                    <br />
                    <b>Topic 地址</b>：
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
                    <br />
                    <b>Topic 状态</b>：
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
                    <br />
                    <b>CRP 工作流进度</b>：
                    {detail.workProgress === null
                      ? (detail.workProgressError ?? "读不到")
                      : `${detail.workProgress}（${detail.workProgressLabel ?? "未知状态"}）`}
                    （同步于 {formatTime(detail.workProgressSyncedAt)}）
                  </p>
                </div>
                <div className="pc-ft" data-style-anchor="release-detail.update-entry">
                  {detail.lockReason === null ? (
                    <Link
                      className="btn btn-sm"
                      href={`/releases/${detail.releaseId}/update${scope.query}`}
                    >
                      更新提测
                    </Link>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled>
                      更新提测
                    </button>
                  )}
                  <div className="spacer" />
                  <span>
                    {detail.lockReason === null
                      ? "补包、换包走更新页，这里不改任何快照"
                      : `现在不能更新：${detail.lockReason}`}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd">
              <h2>状态时间线</h2>
              <span className="hint">按时间正序，最新一条是当前状态</span>
            </div>
            <div className="panel-bd">
              {riskItems.map((item) => (
                <div className="risk" key={item.key}>
                  <span aria-hidden="true">⚠</span>
                  <div>
                    <b>{item.title}</b>
                    <br />
                    {item.body}
                  </div>
                </div>
              ))}
              <div className="timeline" data-style-anchor="release-detail.timeline">
                {timeline.map((entry) => (
                  <div className={`tl-item ${entry.tone}`} key={entry.key}>
                    <div className="tl-dot" aria-hidden="true" />
                    <div className="tl-t">
                      {entry.title}
                      <span className="tl-time num">{entry.at}</span>
                    </div>
                    {entry.notes.map((note) => (
                      <div className="tl-d" key={note}>
                        {note}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="tip">
          <span aria-hidden="true">ⓘ</span>
          <div>
            <b>只有失败的包需要处理。</b>下游停在「等待上游」是正常状态，上游重建成功后会自动继续。
            取消提测会同时放弃 CRP 上的主题，已提交的构建无法撤回。
          </div>
        </div>

        <div className="panel" data-style-anchor="release-detail.danger-zone">
          <div className="panel-hd">
            <h2>危险操作</h2>
            <span className="hint">二次确认后才会执行，不能撤销</span>
          </div>
          <div className="panel-bd">
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
                    <button type="button" className="btn btn-danger" disabled>
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
                    <button type="button" className="btn btn-danger" disabled>
                      取消提测
                    </button>
                    {"　"}
                    <span role="status">{cancelLockReason}</span>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
