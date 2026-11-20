/**
 * CRP 的软件包（project）查询。
 *
 * 投递 Release 只认数字 `ProjectID`，传 0 会被拒（实测 `project not found`），
 * 而调用方手里通常只有软件包名，所以这一步是投递的前置动作。
 */

import { CrpBusinessError, CrpInvalidParameterError } from "./errors";
import type { CrpTransport } from "./request";
import type { CrpProject, CrpRawProject } from "./types";

/**
 * 按名字查软件包。
 *
 * 实测 `POST /project` 的名字是模糊匹配：查 `kwin` 会连 `dde-kwin`、`kwindowsystem`
 * 一起返回。所以调用方必须自己按名字收紧，不能拿第一条就用。
 */
export async function searchProjects(
  transport: CrpTransport,
  { name, branchId }: { name: string; branchId: number },
): Promise<CrpProject[]> {
  if (name.trim() === "") {
    throw new CrpInvalidParameterError("查软件包必须给名字：name 为空");
  }

  const raw = await transport.request<{ Projects?: CrpRawProject[] | null }>({
    method: "POST",
    path: "/project",
    body: {
      page: 0,
      perPage: 0,
      projectGroupID: 0,
      newCommit: false,
      archived: false,
      branchID: branchId,
      name,
    },
  });

  return (raw?.Projects ?? []).map((item) => ({
    id: Number(item.ID),
    name: item.Name,
    raw: item,
  }));
}

/** 查到多个候选时最多回显这么多个名字，够看清是不是投错了包。 */
const CANDIDATE_LIMIT = 10;

/**
 * 从模糊匹配的结果里挑出名字完全相同的那个项目，挑不到就报错。
 *
 * 投递只认 `ProjectID`，而 `POST /project` 的名字是模糊匹配：查 `kwin` 会连 `dde-kwin`、
 * `kwindowsystem` 一起返回。取第一条会把包投到同名前缀的另一个项目上，而且构建会成功、
 * 问题要等到装包才发现，所以这里宁可报错。
 *
 * 单独拆出来是因为演练脚本这类调用方手里只有 `searchProjects` 的结果、拿不到
 * `CrpTransport`，它们也要用**同一套**匹配与报错规则，不能再写一份。
 */
export function pickExactProject(
  projects: readonly CrpProject[],
  projectName: string,
  branchId: number,
): CrpProject {
  const exact = projects.filter((item) => item.name === projectName);

  if (exact.length === 0) {
    const candidates = projects.slice(0, CANDIDATE_LIMIT).map((item) => item.name);
    const detail =
      candidates.length === 0
        ? "CRP 一个都没返回"
        : `CRP 返回了相近的名字：${candidates.join("、")}`;

    throw new CrpBusinessError(
      `CRP 的交付分支 ${branchId} 里没有名字完全等于 ${projectName} 的软件包，无法确定 ProjectID。${detail}`,
    );
  }

  const chosen = exact[0];
  if (!chosen || !Number.isInteger(chosen.id) || chosen.id <= 0) {
    throw new CrpBusinessError(
      `软件包 ${projectName} 在 CRP 里的 ProjectID 不合法：${String(chosen?.id)}`,
    );
  }

  return chosen;
}

/**
 * 按软件包名解析出唯一的 `ProjectID`。
 *
 * 匹配与报错规则在 `pickExactProject` 里，投递路径与演练脚本共用同一份。
 */
export async function resolveProjectId(
  transport: CrpTransport,
  projectName: string,
  branchId: number,
): Promise<number> {
  const projects = await searchProjects(transport, { name: projectName, branchId });

  return pickExactProject(projects, projectName, branchId).id;
}
