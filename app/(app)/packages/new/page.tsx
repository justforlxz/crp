import Link from "next/link";

import { createPackageAction } from "../actions";
import { ActionForm } from "../actionForm";
import { resolveWorkspaceScope } from "../../workspaceScope";

import { PageShell } from "@/components/page-shell";

/**
 * 新建软件包表单。
 *
 * 受保护页面，与 `(app)` 下其它页面同一道关口：未登录由 `resolveWorkspaceScope()` 跳
 * `/login?next=/packages/new`，登录用户照旧看到表单。软件包记录没有工作区归属
 * （`docs/DATA_MODEL.md` §4.8），所以表单本身不需要按工作区取数。
 */
type NewPackagePageProps = {
  searchParams: Promise<{ workspace?: string }>;
};

export default async function NewPackagePage({ searchParams }: NewPackagePageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/packages/new", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="新建软件包">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell title="新建软件包">
      <p>
        <Link href="/packages">返回软件包列表</Link>
      </p>

      <ActionForm action={createPackageAction} submitLabel="保存">
        <p>
          <label>
            名称
            <input name="name" required placeholder="kwin" />
          </label>
        </p>
        <p>
          <label>
            仓库路径
            <input name="repoPath" required placeholder="deepin-kde/kwin" />
          </label>
        </p>
        <p>
          <label>
            默认分支
            <input name="defaultBranch" required placeholder="develop/eagle" />
          </label>
        </p>
        <p>
          <label>
            当前版本（可不填）
            <input name="currentVersion" placeholder="5.27.10.2-1" />
          </label>
        </p>
        <p>
          <label>
            CRP 项目名（可不填）
            <input name="crpProjectName" placeholder="deepin-kde_kwin" />
          </label>
        </p>
        <p className="hint">
          留空表示与包名相同；填了就必须是 CRP 里那个软件包的项目名。两者不一定相同：
          CRP 的项目名允许下划线，包名不允许。
        </p>
      </ActionForm>
    </PageShell>
  );
}
