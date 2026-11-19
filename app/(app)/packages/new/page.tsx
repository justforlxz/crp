import Link from "next/link";

import { createPackageAction } from "../actions";
import { ActionForm } from "../actionForm";

import { PageShell } from "@/components/page-shell";

export default function NewPackagePage() {
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
