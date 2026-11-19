import Link from "next/link";

import { listReleaseProjectChoices } from "@/lib/releases";
import { resolveWorkspaceScope } from "../../workspaceScope";
import { ReleaseWizard } from "./wizard";

// 项目、基线状态与仓库数据都在变，页面不做静态化。
export const dynamic = "force-dynamic";

type NewReleasePageProps = {
  searchParams: Promise<{ workspace?: string }>;
};

export default async function NewReleasePage({ searchParams }: NewReleasePageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/releases/new", query.workspace);

  if (scope.active === null) {
    return (
      <main>
        <h1>创建提测</h1>
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </main>
    );
  }

  const projects = await listReleaseProjectChoices(scope.active.id);

  if (projects.length === 0) {
    return (
      <main>
        <h1>创建提测</h1>
        <p>
          这个工作区还没有项目，提测要挂在项目上。先去
          <Link href={`/projects/new${scope.query}`}>新建项目</Link>
          ，配好软件清单与基线再回来。
        </p>
      </main>
    );
  }

  return (
    <>
      {/* 提测记录列表页属 A13（阶段 10），在那之前「从 CRP 导入」的入口挂在这里。 */}
      <nav style={{ maxWidth: 760, margin: "24px auto 0", textAlign: "right", fontSize: 13 }}>
        <Link href={`/releases/import${scope.query}`}>从 CRP 导入已有提测主题</Link>
      </nav>
      <ReleaseWizard projects={projects} />
    </>
  );
}

