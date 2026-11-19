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
import { getLatestListRun, listBaselines, listSyncRuns } from "@/lib/baselines";
import type { BaselineListItem } from "@/lib/baselines";

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
  searchParams: Promise<{ notice?: string; error?: string }>;
};

export default async function BaselinesPage({ searchParams }: BaselinesPageProps) {
  const query = await searchParams;
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
