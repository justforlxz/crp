/**
 * 基线列表页（MKACG-984 按原型重做）：CRP 交付分支平铺清单。
 *
 * 结构照 `.agents/spec/design/prototype.html` 的基线页与 `design.md` 第七节：
 * `.panel`（`.panel-hd` 标题 +「立即同步」→ `.panel-bd flush table-scroll` 里的 `table.grid`）
 * → `.tip`。名字下面用 `.cell-sub num` 带 CRP 分支 ID，数字列走 `.num`。
 *
 * 只读页面：数据由同步任务写入，页面不自己拉 CRP 或 Shuttle。「立即同步」按钮调
 * `app/(app)/baselines/actions.ts` 里的服务端动作，和定时任务入口共用同一段同步逻辑。
 *
 * 基线的唯一作用是被项目选中，所以这里不做任何业务分类，也不按名字推导类型；
 * `IsCheck` 原样展示，不据此过滤分支。
 */
import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listBaselines } from "@/lib/baselines";
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
  return item.isCheck ? "IsCheck=1（已停止维护）" : "IsCheck=0（可用）";
}

/** 状态点色档：只决定颜色，文案仍由 `stateLabel()` 给（design.md 第五节）。 */
function stateDotTone(state: BaselineListItem["state"]): string {
  if (state === "synced") {
    return "is-ok";
  }

  if (state === "failed") {
    return "is-bad";
  }

  return "is-warn";
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

  const baselines = await listBaselines();

  return (
    <PageShell title="基线">
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

        <div className="panel">
          <div className="panel-hd">
            <h2>基线</h2>
            <span className="hint">来自 CRP 分支，同步时幂等写入</span>
            <div className="spacer" />
            <form action={refreshBaselinesAction}>
              <button type="submit" className="btn btn-primary">
                立即同步
              </button>
            </form>
          </div>
          {baselines.length === 0 ? (
            <div className="panel-bd">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">还没有基线</div>
                <div className="empty-d">先点一次「立即同步」，从 CRP 拉取分支列表。</div>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>分支</th>
                    <th>说明</th>
                    <th>IsCheck</th>
                    <th className="num">软件包</th>
                    <th>架构</th>
                    <th className="num">最近同步</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {baselines.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <span className="cell-sub num">ID {item.crpBranchId}</span>
                      </td>
                      <td>{item.description ?? "—"}</td>
                      <td>
                        <span className={`dot ${item.isCheck ? "is-warn" : "is-ok"}`}>
                          {isCheckLabel(item)}
                        </span>
                      </td>
                      <td className="num">{item.packageCount}</td>
                      <td>
                        {item.arches.length === 0 ? (
                          <span title="同步成功后才会写进来；为空时提测投递会被拒绝，不退回任何默认架构">
                            未同步（不能投递）
                          </span>
                        ) : (
                          <code>{item.arches.join(";")}</code>
                        )}
                      </td>
                      <td className="num">{formatTime(item.syncedAt)}</td>
                      <td>
                        <span className={`dot ${stateDotTone(item.state)}`}>{stateLabel(item)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="tip">
          <span aria-hidden="true">ⓘ</span>
          <div>
            <b>基线只用来被项目选中。</b>
            基线就是 CRP 的一条交付分支，项目从这份清单里挑一个作为目标基线，提测时自动带上，不再单独选择。
            <code>IsCheck=1</code> 表示这条分支已停止维护，仍可选但不建议；「投递架构」为空说明还没同步成功，
            这时提测投递会被拒绝 —— 它不会退回任何默认架构。手动同步会重拉分支列表，并重新拉取「被项目选中」
            的基线的软件包版本；定时任务每小时跑一次，只刷新缓存已过期（1 小时）的基线。同步失败时保留上一次
            成功的数据，失败原因在点「立即同步」后由页面顶部的提示条给出。
          </div>
        </div>
      </div>
    </PageShell>
  );
}
