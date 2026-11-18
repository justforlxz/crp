import Link from "next/link";

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
    <main>
      <h1>软件包</h1>
      <p>
        软件包全平台共用一份登记，依赖只在软件包上维护一次，项目只读引用。
      </p>
      <p>
        <Link href="/packages/new">新建软件包</Link>
      </p>

      {packages.length === 0 ? (
        <p>还没有登记任何软件包。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>仓库路径</th>
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
      )}
    </main>
  );
}
