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
 *
 * 三个字段可以被网址带进来（MKACG-996）：软件包页的「从 CRP 查项目」查到项目后，
 * 用 `?name=&repoPath=&crpProjectName=` 打开这一页，这里把它们填进对应输入框。**跟踪分支
 * 永远不由外部带**：CRP 里没有「这个包跟踪我们哪条分支」这件事，只能由人自己选。
 * 带进来的值照旧要过分校（`parsePackageInput`），预填不等于可信。
 */
type NewPackagePageProps = {
  searchParams: Promise<{
    workspace?: string;
    name?: string;
    repoPath?: string;
    crpProjectName?: string;
  }>;
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

      {/* 从 CRP 查到的项目带进来时说明一句：跟踪分支还得自己选，别让人以为可以直接保存。 */}
      {query.name !== undefined || query.crpProjectName !== undefined ? (
        <p className="hint">
          名称、仓库路径与 CRP 项目名来自刚才在 CRP 里查到的项目。跟踪分支要自己选：CRP 不知道
          这个包在我们这边跟哪条分支。
        </p>
      ) : null}

      <ActionForm action={createPackageAction} submitLabel="保存">
        <p>
          <label>
            名称
            <input name="name" required placeholder="kwin" defaultValue={query.name ?? ""} />
          </label>
        </p>
        <p>
          <label>
            仓库路径
            <input name="repoPath" required placeholder="deepin-kde/kwin" defaultValue={query.repoPath ?? ""} />
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
            <input name="crpProjectName" placeholder="deepin-kde_kwin" defaultValue={query.crpProjectName ?? ""} />
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
