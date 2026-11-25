/**
 * 软件包列表页（MKACG-984 按原型重做）：全平台共用的一份软件包登记。
 *
 * 结构照 `.agents/spec/design/prototype.html` 的软件包页与 `design.md` 第七节：
 * `.panel`（`.panel-hd` 标题 + 右侧新建入口 → `.panel-bd flush table-scroll` 里的 `table.grid`）
 * → `.tip`。列按任务清单固定为：名称 / 仓库 / CRP 项目名 / 分支 / 版本 / 依赖 / 引用。
 *
 * 受保护页面，走 `(app)` 下统一的那道关口：先 `resolveWorkspaceScope()`（未登录由它跳
 * `/login?next=/packages`），再取数。软件包记录不属于任何工作区（`docs/DATA_MODEL.md` §4.8
 * 写明「全局唯一登记」、表上没有工作区列），所以列表查询没有工作区维度可以收窄；
 * 这里只是不再依赖「反正只有登录用户会来」这个隐含前提。
 */
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { listPackages } from "@/lib/packages";

import { resolveWorkspaceScope } from "../workspaceScope";
import { CrpProjectSearch } from "./crpSearch";

// 数据每分钟都在被同步任务改，页面不做静态化。
export const dynamic = "force-dynamic";

type PackagesPageProps = {
  searchParams: Promise<{ workspace?: string }>;
};

export default async function PackagesPage({ searchParams }: PackagesPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/packages", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="软件包">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const packages = await listPackages();

  return (
    <PageShell title="软件包">
      <div className="stack">
        <div className="panel" data-style-anchor="packages.table">
          <div className="panel-hd">
            <h2>软件包登记</h2>
            <span className="hint">全平台共用一份</span>
            <div className="spacer" />
            <Link href="/packages/new" className="btn btn-primary">
              新建软件包
            </Link>
          </div>
          {packages.length === 0 ? (
            <div className="panel-bd" data-style-anchor="packages.empty">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">还没有登记任何软件包</div>
                <div className="empty-d">先把仓库路径与默认分支登记进来，项目才能引用它。</div>
                <Link href="/packages/new" className="btn btn-sm">
                  新建软件包
                </Link>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll" data-style-anchor="packages.table-scroll">
              <table className="grid">
                <thead data-style-anchor="packages.table-header">
                  <tr>
                    <th>名称</th>
                    <th data-style-anchor="packages.header-repo-path">仓库</th>
                    <th data-style-anchor="packages.header-crp-project-name">CRP 项目名</th>
                    <th>分支</th>
                    <th>版本</th>
                    <th className="num">依赖</th>
                    <th className="num">引用</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>
                          <Link href={`/packages/${item.id}`}>{item.name}</Link>
                        </strong>
                      </td>
                      <td className="col-mono">{item.repoPath}</td>
                      {/* 空值不是「没有」：表示按包名去 CRP 里找，列表里写清楚，不留一块空白。 */}
                      <td className="col-mono">{item.crpProjectName ?? "与包名相同"}</td>
                      <td className="col-mono">{item.defaultBranch}</td>
                      <td className="col-mono">{item.currentVersion ?? "—"}</td>
                      <td className="num">{item._count.dependencies}</td>
                      <td className="num">{item._count.projectSoftware}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 不知道 CRP 项目名时先在这里查（MKACG-996），查到直接带去新建表单。 */}
        <CrpProjectSearch />
        <div className="tip">
          <span aria-hidden="true">ⓘ</span>
          <div>
            <b>CRP 项目名与软件包名可以不同。</b>
            例如包名 <code>dde-file-manager</code> 在 CRP 上登记为 <code>v25_filemanager</code>。
            两者不一致时以「CRP 项目名」为准去找主题。依赖也只在这里维护一次：上游依赖决定提测时的投递先后，
            上游没构建成功，下游会一直等；依赖成环保存会被拒绝。
          </div>
        </div>
      </div>
    </PageShell>
  );
}
