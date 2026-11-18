import Link from "next/link";

import { listBaselineChoices, listManagers } from "@/lib/projects";
import { resolveWorkspaceScope } from "../../workspaceScope";
import { createProjectAction } from "../actions";

export const dynamic = "force-dynamic";

type NewProjectPageProps = {
  searchParams: Promise<{ workspace?: string; error?: string }>;
};

function formatTime(value: Date | null): string {
  if (value === null) {
    return "未同步";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default async function NewProjectPage({ searchParams }: NewProjectPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/projects/new", query.workspace);

  if (scope.active === null) {
    return (
      <main>
        <h1>新建项目</h1>
        <p>这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。</p>
      </main>
    );
  }

  const [managers, baselines] = await Promise.all([
    listManagers(scope.active.id),
    listBaselineChoices(),
  ]);

  // 只有 A9 判定为「已同步」的基线能选：已消失、同步失败、未同步三种都拿不到可用的软件包版本。
  const usableBaselines = baselines.filter((baseline) => baseline.state === "synced");
  const unusableBaselines = baselines.filter((baseline) => baseline.state !== "synced");

  return (
    <main>
      <h1>新建项目</h1>
      <p>
        <Link href={`/projects${scope.query}`}>返回项目列表</Link>
      </p>

      {query.error === undefined ? null : <p role="alert">保存失败：{query.error}</p>}

      {managers.length === 0 ? (
        <p>
          这个工作区还没有项目经理，先去
          <Link href={`/managers${scope.query}`}>项目经理页面</Link>
          新建一位，再回来建项目。
        </p>
      ) : null}

      {usableBaselines.length === 0 ? (
        <p>
          这个工作区还没有已同步的 CRP 基线，等项目基线同步完成后才能建项目。
        </p>
      ) : null}

      <form action={createProjectAction}>
        <input type="hidden" name="workspaceId" value={scope.active.id} />
        <input type="hidden" name="workspaceSlug" value={scope.active.slug} />

        <p>
          <label>
            项目名称
            <input name="name" required placeholder="桌面专业版 V25" />
          </label>
        </p>
        <p>
          <label>
            项目标识
            <input name="key" required placeholder="desktop-v25" pattern="[a-z0-9][a-z0-9\-]*" />
          </label>{" "}
          小写字母、数字与连字符，用于网址与外部引用。
        </p>
        <p>
          <label>
            项目经理
            <select name="projectManagerId" required defaultValue="">
              <option value="" disabled>
                请选择项目经理
              </option>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name}（名下 {manager.projectCount} 个项目）
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            CRP 基线
            <select name="baselineId" required defaultValue="">
              <option value="" disabled>
                请选择 CRP 基线
              </option>
              {usableBaselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.name}（同步于 {formatTime(baseline.syncedAt)}）
                </option>
              ))}
            </select>
          </label>
          {unusableBaselines.length === 0 ? null : (
            <>
              {" "}
              暂时不能选：
              {unusableBaselines
                .map((baseline) => `${baseline.name}（${baseline.stateLabel}）`)
                .join("、")}
            </>
          )}
        </p>
        <p>
          <label>
            说明（可不填）
            <input name="description" />
          </label>
        </p>
        <p>
          <button type="submit">保存</button>
        </p>
      </form>
    </main>
  );
}
