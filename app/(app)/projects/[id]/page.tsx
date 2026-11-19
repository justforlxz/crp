import Link from "next/link";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { formatCycle } from "@/lib/packages";
import {
  canViewProject,
  getProject,
  listBaselineChoices,
  listManagers,
  listPackageChoices,
} from "@/lib/projects";
import { resolveWorkspaceScope } from "../../workspaceScope";
import {
  addSoftwareAction,
  copyProjectAction,
  deleteProjectAction,
  removeSoftwareAction,
  updateProjectAction,
  updateSoftwareBranchAction,
} from "../actions";

export const dynamic = "force-dynamic";

type ProjectDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

type ProjectDetail = NonNullable<Awaited<ReturnType<typeof getProject>>>;
type ManagerOption = Awaited<ReturnType<typeof listManagers>>[number];
type BaselineOption = Awaited<ReturnType<typeof listBaselineChoices>>[number];
type PackageChoice = Awaited<ReturnType<typeof listPackageChoices>>[number];

function formatTime(value: Date | null): string {
  if (value === null) {
    return "未同步";
  }

  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: ProjectDetailPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const scope = await resolveWorkspaceScope(`/projects/${id}`, query.workspace);
  const project = await getProject(id, { includeDeleted: scope.account.isPlatformAdmin });

  // 按 id 直接查库，所以这一处判断就是跨工作区读取的唯一关口：
  // 账号不属于任何工作区（scope.active 为空）、项目在别的工作区、或项目已删且不是平台管理员，一律 404。
  if (
    project === null ||
    !canViewProject({
      project,
      activeWorkspaceId: scope.active?.id ?? null,
      isPlatformAdmin: scope.account.isPlatformAdmin,
    })
  ) {
    notFound();
  }

  const workspaceSlug = scope.active?.slug ?? "";
  const [managers, baselines, packages] = await Promise.all([
    listManagers(project.workspaceId),
    listBaselineChoices(),
    listPackageChoices(),
  ]);

  // 可选项只放「已同步」的基线；项目当前绑定的那条无论状态如何都留着，
  // 否则下拉框里看不到当前值，保存时还会被悄悄换成别的基线。
  const usableBaselines = baselines.filter(
    (baseline) => baseline.state === "synced" || baseline.id === project.baselineId,
  );
  const inList = new Set(project.software.entries.map((entry) => entry.packageName));

  return (
    <PageShell title={<>{project.name} <code>{project.key}</code></>}>
      <p>
        <Link href={`/projects${scope.query}`}>返回项目列表</Link>
      </p>

      {query.error === undefined ? null : (
        <p className="alert alert--error" role="alert">
          操作失败：{query.error}
        </p>
      )}
      {query.notice === undefined ? null : (
        <p className="alert alert--info" role="status">
          {query.notice}
        </p>
      )}
      {project.deletedAt === null ? null : (
        <p className="alert alert--info" role="status">
          这个项目已于 {formatTime(project.deletedAt)} 删除：不出现在列表里，也不能再编辑，
          但历史提测记录仍然指向它，可以照常查看。
        </p>
      )}

      <h2>基本信息</h2>
      <dl>
        <dt>项目经理</dt>
        <dd>{project.manager.name}</dd>
        <dt>CRP 基线</dt>
        <dd>
          <code>{project.baseline.name}</code>（同步于 {formatTime(project.baseline.syncedAt)}）
        </dd>
        <dt>说明</dt>
        <dd>{project.description ?? "—"}</dd>
        <dt>软件数</dt>
        <dd>{project.software.count}</dd>
        <dt>依赖数</dt>
        <dd>{project.software.dependencyCount}（清单内部的依赖边）</dd>
        <dt>更新时间</dt>
        <dd>{formatTime(project.updatedAt)}</dd>
      </dl>

      <h2>投递顺序（拓扑排序）</h2>
      <p>
        依赖只在软件包上维护，这里显示的是清单内部的先后关系：上游构建成功才投递下游。
      </p>
      {project.software.order.length === 0 ? (
        <p className="empty">清单还是空的，先把软件包加进来。</p>
      ) : (
        <p>
          <code>{project.software.order.join(" → ")}</code>
        </p>
      )}
      {project.software.cycle === null ? null : (
        <p className="alert alert--error" role="alert">
          依赖成环，排不出投递顺序：{formatCycle(project.software.cycle)}。
          环来自软件包上的依赖配置，去软件包页面解开，项目里不重复配置依赖。
        </p>
      )}

      <SoftwareSection
        project={project}
        workspaceSlug={workspaceSlug}
        inList={inList}
        candidates={packages.filter((item) => !inList.has(item.name))}
      />

      <ProjectForms
        project={project}
        workspaceSlug={workspaceSlug}
        managers={managers}
        usableBaselines={usableBaselines}
      />
    </PageShell>
  );
}

/** 软件清单：投递顺序里的每一项、跟踪分支的修改、移出清单，以及往清单里加包。 */
function SoftwareSection({
  project,
  workspaceSlug,
  inList,
  candidates,
}: {
  project: ProjectDetail;
  workspaceSlug: string;
  inList: ReadonlySet<string>;
  candidates: PackageChoice[];
}) {
  const rowByName = new Map(project.softwareRows.map((row) => [row.packageName, row]));

  return (
    <>
      <h2>软件清单</h2>
      {project.software.entries.length === 0 ? (
        <p className="empty">这个项目还没有软件包。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>顺序</th>
                <th>软件包</th>
                <th>仓库路径</th>
                <th>当前版本</th>
                <th>跟踪分支</th>
                <th>上游依赖（只读）</th>
                <th>上次提测提交</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {project.software.entries.map((entry, index) => {
                const row = rowByName.get(entry.packageName);

                return (
                  <tr key={entry.packageName}>
                    <td>{index + 1}</td>
                    <td>
                      <code>{entry.packageName}</code>
                    </td>
                    <td>{row?.repoPath ?? "—"}</td>
                    <td>{row?.currentVersion ?? "—"}</td>
                    <td>
                      <form action={updateSoftwareBranchAction}>
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
                        <input type="hidden" name="packageId" value={row?.packageId ?? ""} />
                        <input
                          name="trackedBranch"
                          required
                          defaultValue={entry.trackedBranch}
                          size={18}
                        />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          保存分支
                        </button>
                      </form>
                    </td>
                    <td>
                      {entry.upstreamNames.length === 0
                        ? "无"
                        : entry.upstreamNames
                            .slice()
                            .sort()
                            .map((name) => (inList.has(name) ? name : `${name}（清单外）`))
                            .join("、")}
                    </td>
                    <td>
                      {entry.lastSubmittedCommit ? entry.lastSubmittedCommit.slice(0, 12) : "未提测"}
                    </td>
                    <td>
                      <form action={removeSoftwareAction}>
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
                        <input type="hidden" name="packageId" value={row?.packageId ?? ""} />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          移除
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>往清单里加软件包</h3>
      {candidates.length === 0 ? (
        <p>
          没有可加的软件包：要么都已经在清单里，要么还没登记。登记去
          <Link href="/packages">软件包页面</Link>。
        </p>
      ) : (
        <form action={addSoftwareAction}>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
          <p>
            <label>
              软件包
              <select name="packageId" required defaultValue="">
                <option value="" disabled>
                  请选择软件包
                </option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.repoPath}，默认分支 {item.defaultBranch}）
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              本项目跟踪的分支
              <input name="trackedBranch" required placeholder="develop/eagle" />
            </label>{" "}
            可以覆盖软件包的默认分支。
          </p>
          <p>
            <button type="submit" className="btn btn-primary">
              加入清单
            </button>
          </p>
        </form>
      )}
    </>
  );
}

/** 编辑、复制、删除三个表单。复制的说明写在这里，免得和它下面的字段分开看。 */
function ProjectForms({
  project,
  workspaceSlug,
  managers,
  usableBaselines,
}: {
  project: ProjectDetail;
  workspaceSlug: string;
  managers: ManagerOption[];
  usableBaselines: BaselineOption[];
}) {
  return (
    <>
      <h2>编辑项目</h2>
      <form action={updateProjectAction}>
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <p>
          <label>
            项目名称
            <input name="name" required defaultValue={project.name} />
          </label>
        </p>
        <p>
          <label>
            项目标识
            <input name="key" required defaultValue={project.key} pattern="[a-z0-9][a-z0-9\-]*" />
          </label>
        </p>
        <p>
          <label>
            项目经理
            <select name="projectManagerId" required defaultValue={project.projectManagerId}>
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
            <select name="baselineId" required defaultValue={project.baselineId}>
              {usableBaselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.name}
                  {baseline.state === "synced" ? "" : `（${baseline.stateLabel}）`}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            说明
            <input name="description" defaultValue={project.description ?? ""} />
          </label>
        </p>
        <p>
          <button type="submit" className="btn btn-primary">
            保存
          </button>
        </p>
      </form>

      <h2>复制项目</h2>
      <p>
        带走软件清单与每项的跟踪分支；上次提测的提交号不带过来，副本从「还没提测过」开始。
        名称、标识、项目经理与基线都可以改。
      </p>
      <form action={copyProjectAction}>
        <input type="hidden" name="sourceProjectId" value={project.id} />
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <p>
          <label>
            副本名称
            <input name="name" required defaultValue={`${project.name}（副本）`} />
          </label>
        </p>
        <p>
          <label>
            副本标识
            <input
              name="key"
              required
              defaultValue={`${project.key}-copy`}
              pattern="[a-z0-9][a-z0-9\-]*"
            />
          </label>
        </p>
        <p>
          <label>
            项目经理
            <select name="projectManagerId" required defaultValue={project.projectManagerId}>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            CRP 基线
            <select name="baselineId" required defaultValue={project.baselineId}>
              {usableBaselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.name}
                  {baseline.state === "synced" ? "" : `（${baseline.stateLabel}）`}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            说明（留空沿用原项目说明）
            <input name="description" />
          </label>
        </p>
        <p>
          <button type="submit" className="btn btn-primary">
            复制
          </button>
        </p>
      </form>

      <h2>删除项目</h2>
      <p>
        删除只是标记为已删除：不再出现在列表与下拉框里，历史提测记录、快照与构建记录照旧可查。
      </p>
      <form action={deleteProjectAction}>
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <button type="submit" className="btn btn-danger">
          删除项目
        </button>
      </form>
    </>
  );
}
