/**
 * Topic 相关接口：建、放弃、查仓库地址。
 *
 * CRP 没有删除 Topic 的接口（实测 `DELETE /api/topics/{id}` 返回 200 却什么都没做，
 * 见 FINDINGS.md），所以「清理」只能是放弃。
 */

import {
  CrpAuthError,
  CrpBusinessError,
  CrpInvalidParameterError,
  responseSnippet,
} from "./errors";
import type { CrpTransport } from "./request";
import { collectRepoUrls, parseBareId } from "./response";
import type {
  CrpCreateTopicInput,
  CrpCreatedTopic,
  CrpRawTopic,
  CrpTopic,
  CrpRawTopicOwner,
  CrpRawTopicUrls,
  CrpTopicUrls,
  CrpTopicUrlsInput,
} from "./types";

/** 投递 Release 时 CRP 只接受 `test` 类型的 Topic。 */
const TOPIC_TYPE_TEST = "test";

/**
 * 把响应里的 Owner/Members（对象数组）折成请求要的字符串。
 *
 * 两个方向的类型不一样：读回来是 `[{name: "crp-user", ...}]`，写回去必须是
 * `"crp-user"`；直接回传数组会让 CRP 回 400（`Unmarshal type error: expected=string`）。
 */
function namesToString(value: CrpRawTopic["Owner"]): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }

  if (Array.isArray(value)) {
    const names = (value as CrpRawTopicOwner[])
      .map((item) => item.name?.trim() ?? "")
      .filter((name) => name !== "");

    return names.length === 0 ? null : names.join(";");
  }

  return null;
}

/** Owner 的账号名，没有时给空串。导入预览里要显示是谁建的主题。 */
function ownerNames(value: CrpRawTopic["Owner"]): string {
  return namesToString(value) ?? "";
}

/**
 * 把 `GET /topics/{id}` 与 `GET /branches/{id}/topics` 的单项整理成调用方要的结构。
 *
 * `BranchID` 缺失时给 0，由调用方判定「主题没有分支」；这里不做拦截，
 * 因为同一个响应也会被用来展示，缺字段不该让展示整体失败。
 */
export function normalizeTopic(raw: CrpRawTopic): CrpTopic {
  const branchId = Number(raw.BranchID);

  return {
    id: Number(raw.ID),
    name: raw.Name ?? "",
    branchId: Number.isFinite(branchId) ? branchId : 0,
    type: raw.Type ?? "",
    abandoned: raw.Abandoned === true,
    completed: raw.Completed === true,
    state: Number(raw.State ?? 0),
    owner: ownerNames(raw.Owner),
    raw,
  };
}

/** 读单个主题。导入第一步「输入 Topic ID」用它。 */
export async function getTopic(transport: CrpTransport, topicId: number): Promise<CrpTopic> {
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new CrpInvalidParameterError("读主题必须给 Topic ID：topicId 不合法");
  }

  const raw = await transport.request<CrpRawTopic>({ method: "GET", path: `/topics/${topicId}` });

  if (raw === null || typeof raw !== "object") {
    throw new CrpBusinessError(`GET /topics/${topicId} 没有返回主题对象`, {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return normalizeTopic(raw);
}

/** 一次搜索最多返回多少条，防止把整条分支的主题都塞给页面。 */
export const TOPIC_SEARCH_LIMIT = 50;

/**
 * 按名称搜索某条交付分支下的 `test` 类型主题。
 *
 * 为什么不走 `POST /topics/search`：这个部署上该路由对任何请求体都返回 `null`，
 * 实测记录见 FINDINGS.md 第 4.4 节。这里改用 CRP 前端自己在用的
 * `GET /branches/{branch_id}/topics?Type=test`，再按名称做包含匹配。
 *
 * 名字比较不区分大小写：CRP 的主题名里既有中文也有英文缩写，大小写不该影响能不能搜到。
 */
export async function searchTopics(
  transport: CrpTransport,
  input: { branchId: number; name: string },
): Promise<CrpTopic[]> {
  if (!Number.isInteger(input.branchId) || input.branchId <= 0) {
    throw new CrpInvalidParameterError("搜索主题必须给交付分支 ID：branchId 不合法");
  }

  const keyword = input.name.trim().toLowerCase();

  if (keyword === "") {
    throw new CrpInvalidParameterError("搜索主题必须给名称关键字：name 为空");
  }

  const raw = await transport.request<CrpRawTopic[]>({
    method: "GET",
    path: `/branches/${input.branchId}/topics?Type=${TOPIC_TYPE_TEST}`,
  });

  if (!Array.isArray(raw)) {
    throw new CrpBusinessError("GET /branches/{id}/topics 没有返回数组", {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return raw
    .map(normalizeTopic)
    .filter((topic) => topic.type === TOPIC_TYPE_TEST)
    .filter((topic) => topic.name.toLowerCase().includes(keyword))
    .slice(0, TOPIC_SEARCH_LIMIT);
}

export async function createTopic(
  transport: CrpTransport,
  input: CrpCreateTopicInput,
  resolveOwner: () => Promise<string>,
): Promise<CrpCreatedTopic> {
  if (input.name.trim() === "") {
    throw new CrpInvalidParameterError("建 Topic 必须给名字：name 为空");
  }
  if (!Number.isInteger(input.branchId) || input.branchId <= 0) {
    throw new CrpInvalidParameterError("建 Topic 必须给交付分支 ID：branchId 不合法");
  }

  const owner = input.owner?.trim() || (await resolveOwner());
  if (owner === "") {
    throw new CrpAuthError("建 Topic 需要 Owner，但 GET /user 没有返回账号名");
  }

  const raw = await transport.request<unknown>({
    method: "POST",
    path: `/branches/${input.branchId}/topics`,
    body: {
      ID: null,
      Name: input.name,
      TpcType: input.tpcType ?? "public",
      Description: input.description ?? input.name,
      Type: TOPIC_TYPE_TEST,
      NameB64: null,
      BranchID: input.branchId,
      SyncID: 0,
      State: 0,
      Owner: owner,
      Abandoned: false,
      Completed: false,
      Members: null,
      RepoType: input.repoType ?? "deb",
      CopyId: null,
    },
    expectedStatus: [200, 201],
  });

  const topicId = parseBareId(raw);
  if (topicId === null) {
    throw new CrpBusinessError("建 Topic 的响应里没有可识别的 Topic ID", {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return { topicId, name: input.name, owner, raw };
}

/** 放弃 Topic。CRP 侧没有删除能力，这是唯一可用的清理方式。 */
export async function abandonTopic(transport: CrpTransport, topicId: number): Promise<void> {
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new CrpInvalidParameterError("放弃 Topic 必须给 Topic ID：topicId 不合法");
  }

  const raw = await transport.request<CrpRawTopic>({ method: "GET", path: `/topics/${topicId}` });

  await transport.request<unknown>({
    method: "PUT",
    path: `/topics/${topicId}`,
    // CRP 的 PUT 是全量覆盖，所以把读回来的对象原样带回，只改要改的字段。
    body: {
      ...raw,
      Owner: namesToString(raw.Owner),
      Members: namesToString(raw.Members),
      Abandoned: true,
      Completed: Boolean(raw.Completed),
    },
    expectedStatus: [200, 201, 204],
  });
}

/** 查 Topic 的 apt 仓库地址。构建还没产出时 CRP 返回 null，这里统一成空数组。 */
export async function topicUrls(
  transport: CrpTransport,
  input: CrpTopicUrlsInput,
): Promise<CrpTopicUrls> {
  const raw = await transport.request<CrpRawTopicUrls>({
    method: "POST",
    path: "/topic_urls",
    body: { branchID: input.branchId, topicID: input.topicId },
  });

  return { repoUrls: collectRepoUrls(raw ?? {}), raw: raw ?? {} };
}
