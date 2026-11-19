import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { listPackages } from "@/lib/packages";

// 数据每分钟都在被同步任务改，页面不做静态化。
export const dynamic = "force-dynamic";

/** 时间统一按 UTC 显示并标出来，避免读者把本地时间当成同步时间。 */
function formatTime(value: Date | null): string {
  if (!value) {
    return "未同步";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default async function PackagesPage() {
  const packages = await listPackages();

  return (
    <PageShell title="软件包">
      <p data-style-anchor="packages.intro">
        软件包全平台共用一份登记，依赖只在软件包上维护一次，项目只读引用。
      </p>
      <p className="row" data-style-anchor="packages.create-entry">
        <Link href="/packages/new" className="btn btn-primary">
          新建软件包
        </Link>
      </p>

      {packages.length === 0 ? (
        <p className="empty" data-style-anchor="packages.empty">
          还没有登记任何软件包。
        </p>
      ) : (
        <div className="table-scroll" data-style-anchor="packages.table-scroll">
          <table className="data-table" data-style-anchor="packages.table">
            <thead data-style-anchor="packages.table-header">
              <tr>
                <th>名称</th>
                <th data-style-anchor="packages.header-repo-path">仓库路径</th>
                {/* 空值不是「没有」：表示按包名去 CRP 里找，列表里写清楚，不留一块空白。 */}
                <th data-style-anchor="packages.header-crp-project-name">CRP 项目名</th>
                <th>默认分支</th>
                <th>当前版本</th>
                <th>当前 Commit</th>
                <th>上游依赖</th>
                <th>被依赖</th>
                <th>引用项目</th>
                <th>最近同步</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/packages/${item.id}`}>{item.name}</Link>
                  </td>
                  <td>{item.repoPath}</td>
                  {/* 与详情页同一句：留空表示与包名相同。 */}
                  <td>{item.crpProjectName ?? "与包名相同"}</td>
                  <td>{item.defaultBranch}</td>
                  <td>{item.currentVersion ?? "—"}</td>
                  <td>{item.currentCommit ? item.currentCommit.slice(0, 12) : "—"}</td>
                  <td>{item._count.dependencies}</td>
                  <td>{item._count.dependents}</td>
                  <td>{item._count.projectSoftware}</td>
                  <td>{formatTime(item.lastSyncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
