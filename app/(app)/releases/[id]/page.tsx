/**
 * 提测详情（A13）。
 *
 * 一条提测的来龙去脉都在这页：概要条（版本、基线、软件数、创建人、说明、是否已锁定、来源）、
 * 构建状态区块（A14 的组件，这一页只负责挂上去）、「更新提测」入口、更新历史、
 * 软件包提交快照表、CRP 仓库记录关联、提测信息。
 *
 * 两条硬约束落在页面上：
 *
 * - 快照表只读（MUST NOT）：这里没有任何改快照的入口，唯一的变更路径是「更新提测」，
 *   它走 A17 的追加轮次；
 * - 「更新提测」在转测之后置灰并给出原因（AC5）：原因是 A17 判定的同一句话，
 *   页面不解自己的版本。
 *
 * 跨工作区一律 404：按 id 直接查库，所以这一处判断就是跨工作区读取的唯一关口。
 */
import Link from "next/link";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { findReleaseScope } from "@/lib/build";
import {
  canViewRelease,
  loadReleaseDetail,
  ReleaseError,
  releaseSourceLabel,
  releaseStatusLabel,
  SNAPSHOT_COLUMNS,
  snapshotRowCells,
} from "@/lib/releases";
import { resolveWorkspaceScope } from "../../workspaceScope";
import { refreshRepositoryRecordsAction } from "./actions";
import { BuildStatusSection } from "./buildStatusSection";
import { CopyValue } from "./copyValue";

// CRP 进度与构建状态一直在变，页面不做静态化。
export const dynamic = "force-dynamic";

/** 提交号用等宽字体显示，认的是列名而不是下标：列顺序变了也不会串行。 */
const CODE_COLUMNS = new Set(["基线 Commit", "本次 Commit"]);

type ReleaseDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

function formatTime(value: Date | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

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

  const commitErrors = detail.packages.filter((item) => item.commitError !== null);

  return (
    <PageShell title="提测详情">
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

      <h2>概要</h2>
      <dl data-style-anchor="release-detail.summary">
        <dt>提测版本</dt>
        <dd>
          <code>{detail.version}</code>（第 {detail.revision} 轮，
          {releaseStatusLabel(detail.status)}）
        </dd>
        <dt>项目 / CRP 基线</dt>
        <dd>
          {detail.project.name}（<code>{detail.project.key}</code>）· 基线{" "}
          <code>{detail.project.baselineName}</code>
        </dd>
        <dt>软件数</dt>
        <dd>{detail.packages.length}</dd>
        <dt>创建人 / 创建时间</dt>
        <dd>
          {detail.createdByName} · {formatTime(detail.createdAt)}
        </dd>
        <dt>说明</dt>
        <dd>{detail.description === null || detail.description === "" ? "—" : detail.description}</dd>
        <dt>是否已锁定</dt>
        <dd>{detail.lockReason === null ? "未锁定，可以补包或换包" : `已锁定：${detail.lockReason}`}</dd>
        <dt>来源</dt>
        <dd>
          {releaseSourceLabel(detail.source)}
          {detail.source === "imported" && detail.crpTopicUrl !== null ? (
            <>
              {"　"}
              <a href={detail.crpTopicUrl} target="_blank" rel="noreferrer">
                在原 CRP Topic 里查看
              </a>
            </>
          ) : null}
        </dd>
      </dl>
      {/* 构建状态区块（A14）：数据由服务端定时轮询写进库里，这一块只读。 */}
      <BuildStatusSection releaseId={detail.releaseId} />

      <h2 data-style-anchor="release-detail.update-entry">更新提测</h2>
      {detail.lockReason === null ? (
        <p>
          <Link href={`/releases/${detail.releaseId}/update${scope.query}`}>更新提测</Link>
          {"　"}
          补包、换包的流程在更新页里；这里不改任何快照。
        </p>
      ) : (
        <p>
          <button type="button" disabled>
            更新提测
          </button>
          {"　"}
          <span role="status">现在不能更新：{detail.lockReason}</span>
        </p>
      )}

      <h2>更新历史</h2>
      {detail.history.length === 0 ? (
        <p className="empty">这条提测还没有补包或换包记录，只有建提测时的第一轮。</p>
      ) : (
        <div className="table-scroll" data-style-anchor="release-detail.history-table-scroll">
          <table className="data-table" data-style-anchor="release-detail.history-table">
            <thead>
              <tr>
                <th>轮次</th>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>加的包</th>
                <th>放弃的包</th>
                <th>重投的包</th>
              </tr>
            </thead>
            <tbody>
              {detail.history.map((row) => (
                <tr key={row.id}>
                  <td>
                    第 {row.revisionBefore} 轮 → 第 {row.revisionAfter} 轮
                  </td>
                  <td>{formatTime(row.createdAt)}</td>
                  <td>{row.operatorName}</td>
                  <td>{row.action === "append" ? "补包" : "换包"}</td>
                  <td>
                    {row.action === "append" ? <code>{row.packageNames.join("、")}</code> : "—"}
                  </td>
                  <td>
                    <code>{row.abandonedPackages.length === 0 ? "—" : row.abandonedPackages.join("、")}</code>
                  </td>
                  <td>
                    <code>
                      {row.redispatchedPackageNames.length === 0
                        ? "—"
                        : row.redispatchedPackageNames.join("、")}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>软件包提交快照</h2>
      <p>
        共 {detail.packages.length} 个软件包，按依赖顺序排列（上游在前）。这张表是这次提测固化下来的
        内容，只读；要改只能走上面的「更新提测」，改出来的结果是一轮新的快照，历史轮次不动。
      </p>
      <p>
        <a href={`/api/releases/${detail.releaseId}/export`}>导出 CSV</a>
        （列与这张表一致，行数与上面的软件包数一致）
      </p>
      {commitErrors.length === 0 ? null : (
        <p className="alert alert--info" role="status">
          提交说明与提交人读不到 Gerrit 时留空：{commitErrors.map((item) => item.packageName).join("、")}。
          其余列不受影响。
        </p>
      )}
      <div className="table-scroll" data-style-anchor="release-detail.snapshot-table-scroll">
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
                    <td key={`${item.packageName}-${SNAPSHOT_COLUMNS[cellIndex]}`} title={cell}>
                      {CODE_COLUMNS.has(SNAPSHOT_COLUMNS[cellIndex] ?? "") ? <code>{cell}</code> : cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>CRP 仓库记录</h2>
      {detail.repositoryRecords.length === 0 ? (
        <p className="empty">这些软件包还没投递到 CRP，所以还没有仓库记录。</p>
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
      <p>
        「CRP 实际 Tag」是 CRP 自己记录的版本号，可能与「本次提测版本」不同：实测它会把末位数字加一
        （提交 <code>5.16.20</code> 记成 <code>5.16.21</code>）、追加序号（<code>5.7.20</code> 记成{" "}
        <code>5.7.20.2</code>），或带 <code>+uploadcrp</code>、<code>+testbug260209</code> 这样的后缀，
        具体以 CRP 上显示的值为准。提测版本仍按我们提交的值显示与导出，不改写；这一列要等到一次同步之后才有值。
      </p>
      <p>
        最近一次同步：{formatTime(detail.repositorySyncedAt)}
      </p>
      <form action={refreshRepositoryRecordsAction}>
        <input type="hidden" name="releaseId" value={detail.releaseId} />
        <button type="submit" className="btn btn-secondary">刷新 CRP 仓库记录</button>
      </form>
      <p>
        刷新会向 CRP 查一次这条 Topic 下的 Release，再按构建 ID 查 Shuttle 的构建结果，把状态写回本地；
        不修改任何快照，也不往 CRP 发写请求。
      </p>

      <h2>提测信息</h2>
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
    </PageShell>
  );
}
