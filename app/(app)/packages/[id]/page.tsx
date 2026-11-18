import Link from "next/link";
import { notFound } from "next/navigation";

import { getPackageDetail, listBaselineOptions, listPackages } from "@/lib/packages";

import { ActionForm } from "../actionForm";
import {
  deletePackageAction,
  lookupBaselineVersionAction,
  saveDependenciesAction,
  syncPackageAction,
  updatePackageAction,
} from "../actions";

export const dynamic = "force-dynamic";

function formatTime(value: Date | null): string {
  if (!value) {
    return "未同步";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default async function PackageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getPackageDetail(id);

  if (!detail) {
    notFound();
  }

  const [allPackages, baselines] = await Promise.all([
    listPackages(),
    listBaselineOptions(),
  ]);

  const upstreamIds = new Set(
    detail.dependencies.map((item) => item.upstreamPackageId),
  );
  const candidates = allPackages.filter((item) => item.id !== detail.id);
  // 已勾选排前面，长清单里好找。
  candidates.sort((left, right) => {
    const leftChecked = upstreamIds.has(left.id) ? 0 : 1;
    const rightChecked = upstreamIds.has(right.id) ? 0 : 1;
    return leftChecked - rightChecked || left.name.localeCompare(right.name);
  });

  return (
    <main>
      <h1>{detail.name}</h1>
      <p>
        <Link href="/packages">返回软件包列表</Link>
      </p>

      <h2>基本信息</h2>
      <dl>
        <dt>仓库路径</dt>
        <dd>{detail.repoPath}</dd>
        <dt>默认分支</dt>
        <dd>{detail.defaultBranch}</dd>
        <dt>当前版本</dt>
        <dd>{detail.currentVersion ?? "—"}</dd>
        <dt>当前 Commit</dt>
        <dd>{detail.currentCommit ?? "—"}</dd>
        <dt>最近同步</dt>
        <dd>{formatTime(detail.lastSyncedAt)}</dd>
      </dl>

      <h2>同步元数据</h2>
      <p>
        从 Gerrit 读 <code>{detail.repoPath}</code> 的 <code>{detail.defaultBranch}</code>{" "}
        分支当前提交，并解析该提交的 <code>debian/changelog</code> 得到版本。
      </p>
      <ActionForm action={syncPackageAction} submitLabel="从 Gerrit 同步">
        <input type="hidden" name="id" value={detail.id} />
      </ActionForm>

      <h2>编辑</h2>
      <ActionForm action={updatePackageAction} submitLabel="保存">
        <input type="hidden" name="id" value={detail.id} />
        <p>
          <label>
            名称
            <input name="name" required defaultValue={detail.name} />
          </label>
        </p>
        <p>
          <label>
            仓库路径
            <input name="repoPath" required defaultValue={detail.repoPath} />
          </label>
        </p>
        <p>
          <label>
            默认分支
            <input name="defaultBranch" required defaultValue={detail.defaultBranch} />
          </label>
        </p>
        <p>
          <label>
            当前版本（可不填）
            <input name="currentVersion" defaultValue={detail.currentVersion ?? ""} />
          </label>
        </p>
      </ActionForm>

      <h2>上游依赖</h2>
      <p>
        勾选这个包依赖哪些包：上游构建成功才会投递下游。保存时检查依赖环，检测到环会
        拒绝保存并指出回路。
      </p>
      <ActionForm action={saveDependenciesAction} submitLabel="保存依赖">
        <input type="hidden" name="id" value={detail.id} />
        {candidates.length === 0 ? (
          <p>库里还没有别的软件包可以作为上游。</p>
        ) : (
          <ul>
            {candidates.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    name="upstreamIds"
                    value={item.id}
                    defaultChecked={upstreamIds.has(item.id)}
                  />
                  {item.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </ActionForm>

      <h3>当前配置的上游</h3>
      {detail.dependencies.length === 0 ? (
        <p>没有上游依赖。</p>
      ) : (
        <ul>
          {detail.dependencies.map((item) => (
            <li key={item.id}>
              <Link href={`/packages/${item.upstreamPackage.id}`}>
                {item.upstreamPackage.name}
              </Link>
              （{item.upstreamPackage.repoPath}，当前版本{" "}
              {item.upstreamPackage.currentVersion ?? "—"}）
            </li>
          ))}
        </ul>
      )}

      <h3>被哪些软件包依赖</h3>
      {detail.dependents.length === 0 ? (
        <p>没有软件包依赖它。</p>
      ) : (
        <ul>
          {detail.dependents.map((item) => (
            <li key={item.id}>
              <Link href={`/packages/${item.package.id}`}>{item.package.name}</Link>
            </li>
          ))}
        </ul>
      )}

      <h2>引用这个包的项目</h2>
      {detail.projectSoftware.length === 0 ? (
        <p>没有项目引用这个包。</p>
      ) : (
        <ul>
          {detail.projectSoftware.map((item) => (
            <li key={item.id}>
              {item.project.name}（{item.project.key}
              {item.project.deletedAt ? "，已删除" : ""}）跟踪分支{" "}
              <code>{item.trackedBranch}</code>
            </li>
          ))}
        </ul>
      )}

      <h2>基线仓库版本</h2>
      {detail.baselineVersions.length === 0 ? (
        <p>
          还没有基线的软件包版本数据。基线同步属于 A9 节点，同步后这里会列出每个基线里
          这个包的当前版本；也可以用下面的按钮现场向 Shuttle 查一次。
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>基线</th>
              <th>仓库版本</th>
              <th>数据时间</th>
            </tr>
          </thead>
          <tbody>
            {detail.baselineVersions.map((item) => (
              <tr key={item.id}>
                <td>{item.baseline.name}</td>
                <td>{item.version}</td>
                <td>{formatTime(item.fetchedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {baselines.length > 0 ? (
        <ActionForm
          action={lookupBaselineVersionAction}
          submitLabel="向 Shuttle 查一次"
        >
          <input type="hidden" name="packageName" value={detail.name} />
          <p>
            <label>
              基线
              <select name="baselineName" defaultValue={baselines[0].name}>
                {baselines.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </p>
        </ActionForm>
      ) : null}

      <h2>删除</h2>
      <p>仍被项目引用的软件包不能删除；被其他软件包依赖时也要先解除依赖。</p>
      <ActionForm action={deletePackageAction} submitLabel="删除这个软件包">
        <input type="hidden" name="id" value={detail.id} />
      </ActionForm>
    </main>
  );
}
