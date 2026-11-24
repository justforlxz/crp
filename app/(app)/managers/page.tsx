/**
 * 项目经理页（MKACG-971 按原型移植模块结构）。
 *
 * 分区照 `.agents/spec/design/prototype.html` 的项目页经理区与 `design.md` §8：
 * `.section-title` + `.manager-grid` 内多个 `.manager-card`（一张卡一个人），下面是 `design.md`
 * §8 要求的清单表，承担改名这类逐行操作。
 *
 * 字段全部来自 `listManagers()` 已有的数据（姓名、平台账号是否绑定、名下项目数），
 * 不为这张页面新增查询字段。
 */

import Link from "next/link";

import { PageShell } from "@/components/page-shell";
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
      <p>
        项目经理归属于一个工作区，是项目的必填归属人。一个项目只能挂一位项目经理，
        一个项目经理可以负责多个项目。
      </p>

      <p>
        工作区：
        {scope.workspaces.map((workspace) => (
          <span key={workspace.id}>
            <Link href={`/managers?workspace=${encodeURIComponent(workspace.slug)}`}>
              {workspace.name}
            </Link>
            {workspace.id === scope.active?.id ? "（当前）" : null}{" "}
          </span>
        ))}
      </p>

      <p>
        <Link href={`/projects${scope.query}`}>返回项目列表</Link>
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

      <div className="section-title">
        <b>项目经理</b>
        <small>一个项目只能挂一位项目经理；一个项目经理可以负责多个项目。</small>
      </div>
      <ManagerGrid managers={managers} />

      <div className="section-title section-gap">
        <b>新建项目经理</b>
        <small>同一个工作区内不能重名。</small>
      </div>
      <form action={createManagerAction} className="card panel">
        <input type="hidden" name="workspaceId" value={scope.active.id} />
        <input type="hidden" name="workspaceSlug" value={scope.active.slug} />
        <p>
          <label htmlFor="manager-name">姓名</label>{" "}
          <input id="manager-name" name="name" required placeholder="李伟" className="field" />
        </p>
        <p>
          <button type="submit" className="btn primary sm">
            保存
          </button>
        </p>
      </form>

      {managers.length === 0 ? null : (
        <>
          <div className="section-title section-gap">
            <b>项目经理清单</b>
            <small>改名只改姓名，不动工作区归属，也不动名下项目。</small>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>平台账号</th>
                  <th>名下项目数</th>
                  <th>改名</th>
                </tr>
              </thead>
              <tbody>
                {managers.map((manager) => (
                  <tr key={manager.id}>
                    <td>{manager.name}</td>
                    <td>{manager.userId === null ? "未绑定账号" : "已绑定账号"}</td>
                    <td>{manager.projectCount}</td>
                    <td>
                      <form action={renameManagerAction}>
                        <input type="hidden" name="managerId" value={manager.id} />
                        <input
                          type="hidden"
                          name="workspaceSlug"
                          value={scope.active?.slug ?? ""}
                        />
                        <input name="name" required defaultValue={manager.name} size={12} />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          改名
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PageShell>
  );
}
