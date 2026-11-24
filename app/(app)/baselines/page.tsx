/**
 * 基线列表页：CRP 交付分支平铺清单。
 *
 * 只读页面：数据由同步任务写入，页面不自己拉 CRP 或 Shuttle。「立即同步」按钮调
 * `app/(app)/baselines/actions.ts` 里的服务端动作，和定时任务入口共用同一段同步逻辑。
 *
 * 基线的唯一作用是被项目选中，所以这里不做任何业务分类，也不按名字推导类型；
 * `IsCheck` 原样展示，不据此过滤分支。
 */
import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { getLatestListRun, listBaselines, listSyncRuns } from "@/lib/baselines";
import type { BaselineListItem } from "@/lib/baselines";

import { resolveWorkspaceScope } from "../workspaceScope";

import { refreshBaselinesAction } from "./actions";

// 数据每小时都在被同步任务改，页面不做静态化。
export const dynamic = "force-dynamic";

function formatTime(value: Date | null): string {
  if (!value) {
    return "—";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function isCheckLabel(item: BaselineListItem): string {
  return item.isCheck ? "IsCheck=1（已停止维护，不建议选择）" : "IsCheck=0（可用）";
}

/** 状态徽标的颜色档位：只决定颜色，文案仍由 `stateLabel()` 给。 */
function stateBadgeClass(state: BaselineListItem["state"]): string {
  if (state === "synced") {
    return "badge badge--success";
  }

  if (state === "failed") {
    return "badge badge--danger";
  }

  return "badge badge--warn";
}

function stateLabel(item: BaselineListItem): string {
  if (item.state === "failed") {
    return `${item.stateLabel}：${item.latestError ?? "原因未知"}`;
  }

  if (item.state === "missing") {
    return `${item.stateLabel}（${formatTime(item.missingAt)}）`;
  }

  return item.stateLabel;
}

type BaselinesPageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

export default async function BaselinesPage({ searchParams }: BaselinesPageProps) {
  const query = await searchParams;
  // 与 `(app)` 下其它页面同一道关口：未登录由 `resolveWorkspaceScope()` 跳
  // `/login?next=/baselines`。基线是 CRP 交付分支的平铺清单，表上没有工作区列
  // （`docs/DATA_MODEL.md` §4.6），所以下面的查询没有工作区维度可收窄。
  const scope = await resolveWorkspaceScope("/baselines", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="基线">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const [baselines, runs, latestListRun] = await Promise.all([
    listBaselines(),
    listSyncRuns(),
    getLatestListRun(),
  ]);

  return (
    <PageShell title="基线">
      <p>
        基线就是 CRP 的一条交付分支，平铺清单，不做任何分类。项目从这份清单里挑一个作为目标基线，
        挑选时参考描述与 <code>IsCheck</code>；本平台不按分支名推导类型，也不过滤分支。
      </p>

      <Toast
        className="toast alert alert--error"
        role="alert"
        message={query.error === undefined ? null : `操作失败：${query.error}`}
      />
      <Toast
        className="toast alert alert--info"
        message={query.notice === undefined ? null : query.notice}
      />

      <h2>分支列表同步</h2>
      {latestListRun === null ? (
        <p className="empty">还没有同步过分支列表。</p>
      ) : (
        <p>
          最近一次：{latestListRun.status === "success" ? "成功" : latestListRun.status === "failed" ? "同步失败" : "进行中"}
          ，{latestListRun.itemCount} 条，
          {latestListRun.trigger === "manual" ? "手动触发" : "定时触发"}，开始于{" "}
          {formatTime(latestListRun.startedAt)}，结束于 {formatTime(latestListRun.finishedAt)}
          {latestListRun.errorMessage === null ? null : (
            <>
              ；失败原因：<code>{latestListRun.errorMessage}</code>
            </>
          )}
        </p>
      )}

      <form action={refreshBaselinesAction}>
        <button type="submit" className="btn btn-primary">
          立即同步
        </button>
      </form>
      <p>
        手动同步会重拉分支列表，并重新拉取「被项目选中」的基线的软件包版本；定时任务每小时跑一次，
        只刷新缓存已过期（1 小时）的基线。同步失败时保留上一次成功的数据，失败原因记在下面的同步记录里。
      </p>

      <h2>基线清单</h2>
      {baselines.length === 0 ? (
        <p className="empty">还没有基线，先点一次「立即同步」从 CRP 拉分支列表。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>分支名</th>
                <th>说明</th>
                <th>是否可用于打包（IsCheck）</th>
                <th>可选软件包数</th>
                <th>投递架构</th>
                <th>最近同步</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {baselines.map((item) => (
                <tr key={item.id}>
                  <td>
                    <code>{item.name}</code>
                  </td>
                  <td>{item.description ?? "—"}</td>
                  <td>{isCheckLabel(item)}</td>
                  <td>{item.packageCount}</td>
                  <td>
                    {item.arches.length === 0 ? (
                      <span title="同步成功后才会写进来；为空时提测投递会被拒绝，不退回任何默认架构">
                        未同步（不能投递）
                      </span>
                    ) : (
                      <code>{item.arches.join(";")}</code>
                    )}
                  </td>
                  <td>{formatTime(item.syncedAt)}</td>
                  <td>
                    <span className={stateBadgeClass(item.state)}>{stateLabel(item)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tip">
        <div className="tip-icon" aria-hidden="true">
          ⓘ
        </div>
        <div>
          <b>基线只用来被项目选中</b>
          <p>
            基线就是 CRP 的一条交付分支，项目从这份清单里挑一个作为目标基线，提测时自动带上，不再单独选择。
            <code>IsCheck=1</code> 表示这条分支已停止维护，仍可选但不建议；「投递架构」为空说明还没同步成功，
            这时提测投递会被拒绝 —— 它不会退回任何默认架构。同步失败时保留上一次成功的数据，失败原因记在下面的同步记录里。
          </p>
        </div>
      </div>

      <h2>同步记录（最近 20 条）</h2>
      {runs.length === 0 ? (
        <p className="empty">还没有同步记录。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>种类</th>
                <th>范围</th>
                <th>触发</th>
                <th>条数</th>
                <th>结果</th>
                <th>失败原因</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{formatTime(run.startedAt)}</td>
                  <td>{formatTime(run.finishedAt)}</td>
                  <td>{run.kindLabel}</td>
                  <td>{run.targetName ?? "全部"}</td>
                  <td>{run.trigger === "manual" ? "手动" : "定时"}</td>
                  <td>{run.itemCount}</td>
                  <td>
                    {run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "进行中"}
                  </td>
                  <td>
                    <code>{run.errorMessage ?? "—"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
