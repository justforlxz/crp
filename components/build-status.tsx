/**
 * 构建状态区块：提测详情页（A13）引用的只读组件（MKACG-984 按界面规范 v2 重做）。
 *
 * 服务端组件，自己查库：不接 props 里的数据、不调 CRP / Shuttle、不带任何状态。
 * 提测详情页只需要写一行 `<BuildStatusSection releaseId={release.id} />`。
 *
 * 页面**只读**：状态由服务端的定时轮询（`POST /api/jobs/build-poll`）写进库里，
 * 这里不用前端轮询去驱动状态写入（MUST NOT）。
 *
 * 构建日志不在这里展开：只给架构级的状态与 Shuttle 构建任务 ID，要看日志拿 ID 去 Shuttle 查。
 *
 * 结构照 `design.md` 第七节的模块清单，与同页的「仓库记录」「软件包快照」一致：
 *
 *   `section.panel`（`.panel-hd` 里是标题与一条 `.hint`）
 *     → `.panel-bd`：提测状态与只读说明
 *     → `.panel-bd flush table-scroll`：`table.grid`（时间列 `.num`，代码列 `.col-mono`）
 *
 * 两个降级分支（记录不存在、读不到）同样是一个 `.panel`，提示用 `.tip` 放在 `.panel-bd` 里。
 * 面板由这一层自己给，页面不再套一层 `.panel` —— 否则会面板套面板。
 *
 * 拆出 `BuildStatusPanel`（纯展示）是为了单测能直接渲染结构：`BuildStatusBlock` 那层只做
 * 「查库 + 交给面板」两件事，查库要连数据库，结构断言不该被它拖进去。
 */
import type { ReactNode } from "react";

import { buildStatusLabel, formatDuration, loadReleaseBuildStatus } from "@/lib/build";
import type { BuildStatusView } from "@/lib/build";

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

/** 区块外壳：标题进 `.panel-hd`，内容交给调用方摆进 `.panel-bd`。 */
function BuildStatusPanelShell({
  hint,
  children,
}: {
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel" data-style-anchor="release-detail.build-status">
      <div className="panel-hd">
        <h2>构建状态</h2>
        {hint === undefined ? null : <span className="hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** 降级提示：`.tip` 放在 `.panel-bd` 里，与页面其它说明块同一套写法。 */
function BuildStatusNotice({ text, role }: { text: string; role?: "status" }) {
  return (
    <div className="panel-bd">
      <div className="tip" role={role}>
        <span aria-hidden="true">ⓘ</span>
        <div>{text}</div>
      </div>
    </div>
  );
}

export type BuildStatusPanelProps = {
  /** `loadReleaseBuildStatus()` 的结果；`null` 表示记录不存在。 */
  view: BuildStatusView | null;
};

/** 纯展示：拿一份已经读好的构建状态，渲染成 `.panel`。 */
export function BuildStatusPanel({ view }: BuildStatusPanelProps) {
  if (view === null) {
    return (
      <BuildStatusPanelShell>
        <BuildStatusNotice text="这条提测记录不存在，可能已被删除。" />
      </BuildStatusPanelShell>
    );
  }

  return (
    <BuildStatusPanelShell hint="数据由服务端定时轮询写入，这一块只读">
      <div className="panel-bd">
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
      </div>

      {view.tasks.length === 0 ? (
        <BuildStatusNotice text="这条提测还没有软件包。" />
      ) : (
        <div className="panel-bd flush table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>软件包</th>
                <th>阶段</th>
                <th>提测版本</th>
                <th>架构状态</th>
                <th className="num">耗时</th>
                <th className="num">最近轮询</th>
                <th>原因</th>
                <th>CRP Release ID</th>
                <th>Shuttle 构建任务 ID</th>
              </tr>
            </thead>
            <tbody>
              {view.tasks.map((task) => (
                <tr key={task.snapshotId}>
                  <td className="col-mono">
                    <code>{task.packageName}</code>
                  </td>
                  <td>{task.stage}</td>
                  <td className="col-mono">
                    <code>{task.releaseVersion}</code>
                  </td>
                  <td>{describeArches(task.arches)}</td>
                  <td className="num">{formatDuration(task.durationMs)}</td>
                  <td className="num">{formatTime(task.lastPolledAt)}</td>
                  <td>{task.reason ?? "—"}</td>
                  <td className="col-mono">
                    {task.crpReleaseId === null ? "—" : <code>{task.crpReleaseId}</code>}
                  </td>
                  <td className="col-mono">
                    {task.shuttleTaskId === null ? "—" : <code>{task.shuttleTaskId}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BuildStatusPanelShell>
  );
}

export type BuildStatusBlockProps = {
  /** 提测记录 ID。 */
  releaseId: string;
};

/** 详情页用的挂载点：查库，然后交给纯展示那一层。 */
export async function BuildStatusBlock({ releaseId }: BuildStatusBlockProps) {
  return <BuildStatusPanel view={await loadReleaseBuildStatus(releaseId)} />;
}
