/**
 * 软件包在某个 CRP 基线交付仓库里的当前版本。
 *
 * 复用 A4 的 Shuttle 客户端。只查不写：`baseline_package_version` 的批量同步属于 A9，
 * 这里按「某人点了查一下」的粒度发请求，避免把基线整表同步搬进本节点。
 */

import type { ShuttleClient } from "../integrations/shuttle";

export type BaselineVersionQuery = {
  baselineName: string;
  packageName: string;
};

/**
 * 查一个软件包在指定基线里的版本，查不到返回 `null`。
 *
 * 返回 `null` 有两种情况（基线里没有这个包 / 仓库索引里没有它），对使用者是同一件事：
 * 这个基线里还没有这个版本的包。
 */
export async function fetchBaselineVersion(
  shuttle: Pick<ShuttleClient, "listBaselinePackages">,
  query: BaselineVersionQuery,
): Promise<string | null> {
  const packages = await shuttle.listBaselinePackages(query.baselineName);
  const found = packages.find((item) => item.name === query.packageName);

  return found ? found.version : null;
}
