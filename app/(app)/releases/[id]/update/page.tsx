import Link from "next/link";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { findReleaseScope } from "@/lib/build";
import {
  canViewRelease,
  loadReleaseUpdateView,
  ReleaseError,
  releaseUpdateActionLabel,
} from "@/lib/releases";
import { resolveWorkspaceScope } from "../../../workspaceScope";
import { UpdateReleaseForm } from "./updateForm";

// CRP 进度、构建状态、软件包清单都在变，页面不做静态化。
export const dynamic = "force-dynamic";

type UpdateReleasePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workspace?: string }>;
};

function formatTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19);
}

export default async function UpdateReleasePage({ params, searchParams }: UpdateReleasePageProps) {
  const { id } = await params;
  const query = await searchParams;
  const scope = await resolveWorkspaceScope(`/releases/${id}/update`, query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="更新提测">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  // 这个页面按 id 直接查库，所以这一处判断就是跨工作区读取的唯一关口：提测不存在、
  // 账号不属于任何工作区、提测在别的工作区，一律 404（与接口侧 authorize 同一口径）。
  const owner = await findReleaseScope(id);

  if (
    !canViewRelease({
      release: owner === null ? null : { workspaceId: owner.workspaceId },
      activeWorkspaceId: scope.active?.id ?? null,
    })
  ) {
    notFound();
  }

  let view;

  try {
    view = await loadReleaseUpdateView(id);
  } catch (error) {
    if (error instanceof ReleaseError) {
      return (
        <PageShell title="更新提测">
          <p className="alert alert--error" role="alert">{error.message}</p>
          <p>
            <Link href="/releases/new">回到创建提测</Link>
          </p>
        </PageShell>
      );
    }

    throw error;
  }

  return (
    <PageShell title="更新提测">
      <p>
        {view.projectName}（{view.projectKey}）· 提测版本 <code>{view.version}</code> · 第{" "}
        {view.revision} 轮。转测前可以补包、换包；换掉上游之后，依赖它的下游会一起作废重投。
      </p>

      <dl>
        <dt>提测状态</dt>
        <dd>
          <code>{view.status}</code>
        </dd>
        <dt>CRP Topic</dt>
        <dd>{view.crpTopicId === null ? "还没建 Topic（尚未投递）" : <code>{view.crpTopicId}</code>}</dd>
        <dt>CRP 工作流进度</dt>
        <dd>
          {view.workProgress === null
            ? (view.workProgressError ?? "读不到")
            : `${view.workProgress}（${view.workProgressLabel ?? "未知状态"}）`}
        </dd>
      </dl>

      {view.lockReason === null ? null : (
        <p className="alert alert--error" role="alert">
          现在不能改：{view.lockReason}
        </p>
      )}

      <h2>现有软件包</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>软件包</th>
              <th>轮次</th>
              <th>分支</th>
              <th>Commit</th>
              <th>代码版本</th>
              <th>提测版本（Tag）</th>
              <th>快照状态</th>
            </tr>
          </thead>
          <tbody>
            {view.packages.map((item) => (
              <tr key={item.packageName}>
                <td>{item.packageName}</td>
                <td>{item.attempt}</td>
                <td>
                  <code>{item.branch}</code>
                </td>
                <td>
                  <code>{item.commitSha.slice(0, 12)}</code>
                </td>
                <td>{item.codeVersion}</td>
                <td>{item.releaseVersion}</td>
                <td>
                  <code>{item.snapshotStatus}</code>
                  {item.statusReason === null ? null : (
                    <>
                      <br />
                      <small>{item.statusReason}</small>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UpdateReleaseForm
        releaseId={view.releaseId}
        projectId={view.projectId}
        currentPackages={view.packages.map((item) => ({
          packageName: item.packageName,
          branch: item.branch,
          commitSha: item.commitSha,
          codeVersion: item.codeVersion,
          releaseVersion: item.releaseVersion,
          snapshotStatus: item.snapshotStatus,
        }))}
        candidates={view.candidates}
        locked={view.lockReason !== null}
      />

      <h2>每轮更新留痕</h2>
      {view.history.length === 0 ? (
        <p className="empty">这条提测还没有补包或换包记录。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>涉及的包</th>
                <th>放弃的 CRP Release</th>
                <th>重投的包</th>
                <th>轮次</th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((row) => (
                <tr key={row.id}>
                  <td>{formatTime(row.createdAt)}</td>
                  <td>{row.operatorName}</td>
                  <td>{releaseUpdateActionLabel(row.action)}</td>
                  <td>
                    <code>{row.packageNames.join("、")}</code>
                  </td>
                  <td>
                    <code>
                      {row.abandonedCrpReleaseIds.length === 0
                        ? "—"
                        : row.abandonedCrpReleaseIds.join("、")}
                    </code>
                  </td>
                  <td>
                    <code>{row.redispatchedPackageNames.join("、")}</code>
                  </td>
                  <td>
                    {row.revisionBefore} → {row.revisionAfter}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p>
        <Link href="/releases/new">再建一个提测</Link>
      </p>
    </PageShell>
  );
}
