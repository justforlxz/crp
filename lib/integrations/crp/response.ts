/**
 * CRP 响应的纯函数解析工具。
 *
 * 这几个函数不碰网络、不碰磁盘，全部可以单独测：CRP 的响应形态有好几种特例
 * （裸数字、对象数组、`message` 字段），集中在这里比散在各接口里好核对。
 */

import type { CrpRawTopicUrls } from "./types";

/** 从响应体里读 CRP 的原话；读不出来返回 null。 */
export function readMessage(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { message?: unknown; Message?: unknown };
      const message = record.message ?? record.Message;
      if (typeof message === "string" && message.trim() !== "") {
        return message.trim();
      }
    }
  } catch {
    // 非 JSON 响应没有结构化原因可读。
  }

  return null;
}

/**
 * 把裸响应解析成 ID。
 *
 * 实测：建 Topic 和投递 Release 都返回 `201` + 裸数字（例如 `29158`），
 * 既不是 JSON 对象也不是 JSON 数字。这里把三种形态都收下。
 */
export function parseBareId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }

  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    return Number(raw.trim());
  }

  if (raw !== null && typeof raw === "object") {
    const record = raw as { ID?: unknown; id?: unknown };
    const id = record.ID ?? record.id;
    if (typeof id === "number" && Number.isFinite(id)) {
      return id;
    }
  }

  return null;
}

/** 把 `RepoUrls` 的几种形态统一成字符串数组：没有产出时是 `null`，有时是字符串，有时是数组。 */
export function collectRepoUrls(raw: CrpRawTopicUrls): string[] {
  const value = raw.RepoUrls;

  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value.trim()];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }

  return [];
}
