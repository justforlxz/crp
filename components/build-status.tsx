/**
 * 构建状态区块：提测详情页（A13）引用的只读组件。
 *
 * 服务端组件，自己查库：不接 props 里的数据、不调 CRP / Shuttle、不带任何状态。
 * 提测详情页只需要写一行 `<BuildStatusBlock releaseId={release.id} />`。
 *
 * 页面**只读**：状态由服务端的定时轮询（`POST /api/jobs/build-poll`）写进库里，
 * 这里不用前端轮询去驱动状态写入（MUST NOT）。
 *
 * 构建日志不在这里展开：只给架构级的状态与 Shuttle 构建任务 ID，要看日志拿 ID 去 Shuttle 查。
 */
import { buildStatusLabel, formatDuration, loadReleaseBuildStatus } from "@/lib/build";

function formatTime(value: Date | null): string {
  if (!value) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function describeArches(arches: ReadonlyArray<{ arch: string; status: string }>): string {
  if (arches.length === 0) {
    return "—";
  }

  return arches.map((item) => `${item.arch}：${buildStatusLabel(item.status)}`).join("；");
}

export type BuildStatusBlockProps = {
  /** 提测记录 ID。 */
  releaseId: string;
};

export async function BuildStatusBlock({ releaseId }: BuildStatusBlockProps) {
  const view = await loadReleaseBuildStatus(releaseId);

  if (view === null) {
    return (
      <section>
        <h2 className="section-title">构建状态</h2>
        <p>这条提测记录不存在，可能已被删除。</p>
      </section>
    );
  }

  return (
    <section data-style-anchor="release-detail.build-status">
      <h2 className="section-title">构建状态</h2>
      <p>
        提测状态：{view.statusLabel}；CRP 工作流进度：
        {view.workProgress === null
          ? "还没同步到"
          : `${view.workProgress} ${view.workProgressLabel ?? ""}`}
        （最近同步：{formatTime(view.workProgressSyncedAt)}）
        {view.crpTopicId === null ? null : (
          <>
            ；CRP Topic ID：<code>{view.crpTopicId}</code>
          </>
        )}
      </p>
      <p>
        这一块只读：状态由服务端定时轮询写入。轮询失败不会把构建改成失败，
        只记一条同步错误（见构建队列页的调度事件流水）。
      </p>

      {view.tasks.length === 0 ? (
        <p>这条提测还没有软件包。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>软件包</th>
                <th>阶段</th>
                <th>提测版本</th>
                <th>架构状态</th>
                <th>耗时</th>
                <th>最近轮询</th>
                <th>原因</th>
                <th>CRP Release ID</th>
                <th>Shuttle 构建任务 ID</th>
              </tr>
            </thead>
            <tbody>
              {view.tasks.map((task) => (
                <tr key={task.snapshotId}>
                  <td>
                    <code>{task.packageName}</code>
                  </td>
                  <td>{task.stage}</td>
                  <td>
                    <code>{task.releaseVersion}</code>
                  </td>
                  <td>{describeArches(task.arches)}</td>
                  <td>{formatDuration(task.durationMs)}</td>
                  <td>{formatTime(task.lastPolledAt)}</td>
                  <td>{task.reason ?? "—"}</td>
                  <td>{task.crpReleaseId === null ? "—" : <code>{task.crpReleaseId}</code>}</td>
                  <td>{task.shuttleTaskId === null ? "—" : <code>{task.shuttleTaskId}</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
