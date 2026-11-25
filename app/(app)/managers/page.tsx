/**
 * 项目经理页（MKACG-971 / MKACG-984 按原型重做）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目经理页与 `design.md` 第七节：
 *
 *   `.manager-grid` 经理卡 → `.panel` 清单表 → `.panel` 新建表单
 *
 * 卡片与项目页共用 `ManagerGrid`，两处的「名下项目」数来自同一次查询（FUNC-13）。
 * 清单表承担改名这类逐行操作，卡片只负责扫读。
 *
 * 字段全部来自 `listManagers()` 已有的数据（姓名、平台账号是否绑定、名下项目数），
 * 不为这张页面新增查询字段。
 */

import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listManagers } from "@/lib/projects";
import { resolveWorkspaceScope } from "../workspaceScope";
import { createManagerAction, renameManagerAction } from "./actions";
import { ManagerGrid } from "./managerGrid";

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

        <ManagerGrid managers={managers} />

        <div className="panel">
          <div className="panel-hd">
            <h2>项目经理清单</h2>
            <span className="hint">共 {managers.length} 人</span>
          </div>

          <form method="get" action="/managers" className="filters">
            <select
              className="select"
              name="workspace"
              defaultValue={scope.active.slug}
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
          {managers.length === 0 ? (
            <div className="panel-bd">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">这个工作区还没有项目经理</div>
                <div className="empty-d">在下面的表单里新建一位，再把它分配给项目。</div>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>平台账号</th>
                    <th className="num">名下项目</th>
                    <th>改名</th>
                  </tr>
                </thead>
                <tbody>
                  {managers.map((manager) => (
                    <tr key={manager.id}>
                      <td>
                        <strong>{manager.name}</strong>
                      </td>
                      <td>{manager.userId === null ? "未绑定账号" : "已绑定账号"}</td>
                      <td className="num">{manager.projectCount}</td>
                      <td>
                        <form action={renameManagerAction} className="tag-actions">
                          <input type="hidden" name="managerId" value={manager.id} />
                          <input
                            type="hidden"
                            name="workspaceSlug"
                            value={scope.active?.slug ?? ""}
                          />
                          <input
                            className="input-sm"
                            name="name"
                            required
                            defaultValue={manager.name}
                            aria-label={`把 ${manager.name} 改名`}
                            size={12}
                          />
                          <button type="submit" className="btn btn-sm">
                            改名
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>新建项目经理</h2>
            <span className="hint">同一个工作区内不能重名</span>
          </div>
          <div className="panel-bd">
            <form action={createManagerAction}>
              <input type="hidden" name="workspaceId" value={scope.active.id} />
              <input type="hidden" name="workspaceSlug" value={scope.active.slug} />
              <div className="field">
                <label className="label" htmlFor="manager-name">
                  姓名
                </label>
                <input
                  id="manager-name"
                  name="name"
                  required
                  placeholder="李伟"
                  className="input"
                />
                <div className="note">改名只改姓名，不动工作区归属，也不动名下项目。</div>
              </div>
              <button type="submit" className="btn btn-primary">
                保存
              </button>
            </form>
            <p>
              <Link className="text-link" href={`/projects${scope.query}`}>
                返回项目列表 →
              </Link>
            </p>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
