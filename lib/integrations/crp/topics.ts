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
