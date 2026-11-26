/**
 * 项目经理页（MKACG-971 / MKACG-984 按原型重做，MKACG-1017 去掉工作区分组）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目经理页与 `design.md` 第七节：
 *
 *   `.manager-grid` 经理卡 → `.panel` 清单表（头部「新建项目经理」按钮打开 `.modal` 弹窗）
 *
 * 卡片与项目页共用同构的 `ManagerGrid`，两处的第二行都是邮箱（MKACG-1017）。
 * 清单表四列：姓名 / 邮箱 / 名下项目 / 进行中提测 —— 没有「工作区」「平台账号」「改名」列；
 * 改名与邮箱都在点卡片打开的编辑弹窗里。
 *
 * 工作区只在账号属于两个以上时才出现切换器（MKACG-1017）：工作区是数据层的多租户边界，
 * 不是界面上的分组维度，只有一个工作区时页面上不写工作区名。
 *
 * 字段全部来自 `listManagers()` 已有的数据（姓名、邮箱、名下项目数、进行中提测数），
 * 不为这张页面新增查询字段。
 */

import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listManagers } from "@/lib/projects";
import { resolveWorkspaceScope, showsWorkspaceSwitcher } from "../workspaceScope";
import { ManagerGridWithDialog } from "./managerGridDialog";
import { NewManagerDialog } from "./newManagerDialog";

// 项目经理与项目数随配置变化，页面不做静态化。
export const dynamic = "force-dynamic";

type ManagersPageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

export default async function ManagersPage({ searchParams }: ManagersPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/managers", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="项目经理">
        <p>这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。</p>
      </PageShell>
    );
  }

  const managers = await listManagers(scope.active.id);
  const workspaceId = scope.active.id;
  const workspaceSlug = scope.active.slug;

  return (
    <PageShell title="项目经理">
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

        <ManagerGridWithDialog
          managers={managers}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />

        <div className="panel">
          <div className="panel-hd">
            <h2>项目经理清单</h2>
            <span className="hint">共 {managers.length} 人</span>
            <div className="spacer" />
            <Link className="text-link" href={`/projects${scope.query}`}>
              返回项目列表 →
            </Link>
            <NewManagerDialog workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
          </div>

          {showsWorkspaceSwitcher(scope.workspaces) ? (
            <form method="get" action="/managers" className="filters">
              <select
                className="select"
                name="workspace"
                defaultValue={workspaceSlug}
                aria-label="工作区"
              >
                {scope.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.slug}>
                    {workspace.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-sm">
                切换工作区
              </button>
              <div className="spacer" />
              <span className="result-n">共 {managers.length} 位项目经理</span>
            </form>
          ) : null}

          {managers.length === 0 ? (
            <div className="panel-bd">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">这个工作区还没有项目经理</div>
                <div className="empty-d">点右上角「新建项目经理」新建一位，再把它分配给项目。</div>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>邮箱</th>
                    <th className="num">名下项目</th>
                    <th className="num">进行中提测</th>
                  </tr>
                </thead>
                <tbody>
                  {managers.map((manager) => (
                    <tr key={manager.id}>
                      <td>
                        <strong>{manager.name}</strong>
                      </td>
                      <td className="col-mono">
                        {manager.email === null || manager.email === "" ? "未填写邮箱" : manager.email}
                      </td>
                      <td className="num">{manager.projectCount}</td>
                      <td className="num">{manager.activeReleaseCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
