/**
 * Release（提测投递记录）相关接口：投递、查询、删除、重试。
 *
 * 投递最容易踩的三个坑，全部来自实测（见 FINDINGS.md）：
 *
 * 1. `ProjectID` 必须是真的数字，传 0 会被拒（`project not found`）。
 * 2. 同一个 Topic 里，同一个 project + branch 只能有一个 Release，换包必须先删旧的。
 * 3. `ChangeLogMode=false` 时 Tag 由调用方决定，且不能含 `-`、`_`、空格，必须以数字开头。
 */

import { CrpBusinessError, CrpInvalidParameterError, responseSnippet } from "./errors";
import { resolveProjectId } from "./projects";
import type { CrpTransport } from "./request";
import { parseBareId } from "./response";
import { validateReleaseTag } from "./tag";
import type {
  CrpNewReleasePayload,
  CrpRawRelease,
  CrpRelease,
  CrpSubmitReleaseInput,
  CrpSubmittedRelease,
} from "./types";

/** 投递 Release 时 CRP 只接受 `test` 类型的 Topic。 */
const TOPIC_TYPE_TEST = "test";

/** `ChangeLogMode=true` 时 CRP 会忽略 Tag；这里仍带一个占位值，与 CRP 前端一致。 */
const CHANGELOG_MODE_TAG = "1";

/**
 * CRP 用它拒绝长度不对的提交号：`HTTP 500 commitID 长度异常 请重新提交`。
 * 实测记录见 `FINDINGS.md` 第 12.2 节。
 */
const COMMIT_LENGTH_REJECTION = "commitID 长度异常";

/** 投递参数在本地能判定为非法时，直接抛错，不发请求。 */
function assertSubmitInput(input: CrpSubmitReleaseInput): void {
  if (!Number.isInteger(input.topicId) || input.topicId <= 0) {
    throw new CrpInvalidParameterError("投递 Release 必须给 Topic ID：topicId 不合法");
  }
  if (!Number.isInteger(input.branchId) || input.branchId <= 0) {
    throw new CrpInvalidParameterError("投递 Release 必须给交付分支 ID：branchId 不合法");
  }
  if (
    input.projectName.trim() === "" ||
    input.branch.trim() === "" ||
    input.commit.trim() === ""
  ) {
    throw new CrpInvalidParameterError(
      "投递 Release 需要 projectName、branch、commit 三个非空参数",
    );
  }
  // 架构集合必须由调用方给（来自提测所属基线）。这里不放默认值：写死一套架构时，
  // 基线不支持的架构会让 CRP 在 apply 阶段拒掉整批投递，且看不出是哪一步错的（MKACG-912）。
  if (input.arches.trim() === "") {
    throw new CrpInvalidParameterError(
      "投递 Release 必须给架构集合：arches 不能为空，它来自提测所属基线",
    );
  }
}

/** 组装 CRP 收到的请求体。字段名与类型都是 CRP 原生约定：`BranchID` 是字符串、`ProjectID` 是数字。 */
export function buildNewReleasePayload(
  input: CrpSubmitReleaseInput,
  projectId: number,
  tag: string,
  changeLogMode: boolean,
): CrpNewReleasePayload {
  return {
    Arches: input.arches,
    BaseTag: null,
    Branch: input.branch,
    BuildID: 0,
    BuildState: null,
    Changelog: [input.changelog ?? ""],
    Commit: input.commit,
    History: null,
    ID: 0,
    ProjectID: projectId,
    ProjectName: input.projectName,
    ProjectRepoUrl: null,
    SlaveNode: null,
    Tag: tag,
    TagSuffix: input.tagSuffix ?? null,
    TopicID: input.topicId,
    TopicType: TOPIC_TYPE_TEST,
    ChangeLogMode: changeLogMode,
    RepoType: input.repoType ?? "deb",
    Custom: input.custom ?? true,
    BranchID: String(input.branchId),
  };
}

export async function submitRelease(
  transport: CrpTransport,
  input: CrpSubmitReleaseInput,
): Promise<CrpSubmittedRelease> {
  assertSubmitInput(input);

  const changeLogMode = input.changeLogMode ?? false;
  // ChangeLogMode=false 时 CRP 直接用我们给的 Tag，所以本地先按实测规则挡一遍。
  // ChangeLogMode=true 时 Tag 由 CRP 生成，传什么都会被忽略，不用校验。
  if (!changeLogMode) {
    const reason = validateReleaseTag(input.tag ?? "");
    if (reason !== null) {
      throw new CrpInvalidParameterError(reason);
    }
  }

  const tag = changeLogMode ? (input.tag ?? CHANGELOG_MODE_TAG) : (input.tag as string);
  const projectId = input.projectId ?? (await resolveProjectId(transport, input.projectName, input.branchId));
  const payload = buildNewReleasePayload(input, projectId, tag, changeLogMode);

  let raw: unknown;

  try {
    raw = await transport.request<unknown>({
      method: "POST",
      path: `/topics/${input.topicId}/new_release`,
      body: payload,
      expectedStatus: [200, 201],
    });
  } catch (error) {
    // CRP 只收完整 40 位提交号，短号会被它拒成 `commitID 长度异常 请重新提交`。
    // 重试同样的提交号没有意义，所以归成参数错误（调用方按 409 报错并说明要几位），
    // 不要混进「CRP 服务端异常」，否则用户只看到 502，判断不出是自己填错了。
    if (
      error instanceof CrpBusinessError &&
      (error.responseSnippet ?? "").includes(COMMIT_LENGTH_REJECTION)
    ) {
      throw new CrpInvalidParameterError(
        `提交号需要完整的 40 位十六进制，CRP 拒绝了这个提交：${input.commit.trim()}`,
        { status: error.status, responseSnippet: error.responseSnippet, cause: error },
      );
    }

    throw error;
  }

  const releaseId = parseBareId(raw);
  if (releaseId === null) {
    throw new CrpBusinessError("投递 Release 的响应里没有可识别的 Release ID", {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return {
    releaseId,
    topicId: input.topicId,
    projectId,
    projectName: input.projectName,
    branch: input.branch,
    commit: input.commit,
    tag,
    changeLogMode,
    request: payload,
    raw,
  };
}

export async function listReleases(
  transport: CrpTransport,
  topicId: number,
): Promise<CrpRelease[]> {
  const raw = await transport.request<CrpRawRelease[]>({
    method: "GET",
    path: `/topics/${topicId}/releases`,
  });

  if (!Array.isArray(raw)) {
    throw new CrpBusinessError("GET /topics/{id}/releases 没有返回数组", {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return raw.map((item) => ({
    releaseId: Number(item.ID),
    buildId: Number(item.BuildID ?? 0),
    projectId: Number(item.ProjectID ?? 0),
    projectName: item.ProjectName ?? "",
    branch: item.Branch ?? "",
    commit: item.Commit ?? "",
    tag: item.Tag ?? "",
    buildState: item.BuildState?.state ?? "UNKNOWN",
    changelog: item.Changelog ?? [],
    changeLogMode: item.ChangeLogMode === true,
    raw: item,
  }));
}

export async function deleteRelease(
  transport: CrpTransport,
  releaseId: number,
): Promise<void> {
  if (!Number.isInteger(releaseId) || releaseId <= 0) {
    throw new CrpInvalidParameterError("删除 Release 必须给 Release ID：releaseId 不合法");
  }

  await transport.request<unknown>({
    method: "DELETE",
    path: `/topic_releases/${releaseId}`,
    expectedStatus: [200, 202, 204],
  });
}

/**
 * 重试 Release。
 *
 * 实测当前 CRP 部署对 `POST /api/topic_releases/{id}/retry` 一律回 404，
 * 所以这个方法在本环境不会成功；重试失败的构建要走 Shuttle 的 `/job/rebuild`（A4）。
 * 保留实现是为了接口完整与将来 CRP 恢复该路由。
 */
export async function retryRelease(
  transport: CrpTransport,
  releaseId: number,
): Promise<void> {
  if (!Number.isInteger(releaseId) || releaseId <= 0) {
    throw new CrpInvalidParameterError("重试 Release 必须给 Release ID：releaseId 不合法");
  }

  await transport.request<unknown>({
    method: "POST",
    path: `/topic_releases/${releaseId}/retry`,
    expectedStatus: [200, 201, 202, 204],
  });
}
