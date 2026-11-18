/**
 * 软件包元数据同步：从 Gerrit 拉默认分支的当前 Commit 与 `debian/changelog` 版本。
 *
 * 复用 A3 的客户端（`lib/integrations/gerrit`），不重写请求与 changelog 解析。
 * 取数部分做成可注入客户端的函数，单测用假客户端就能覆盖成功与失败，不碰网络。
 */

/** 从 Gerrit 读到的元数据。 */
export type PackageMetadata = {
  /** 实际命中的分支名，与登记值一致时说明分支还在。 */
  defaultBranch: string;
  /** 该分支当前指向的提交。 */
  currentCommit: string;
  /** 该提交上 `debian/changelog` 首条条目的版本。 */
  currentVersion: string;
};

/** Gerrit 里找不到登记的分支时抛出。 */
export class PackageSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageSyncError";
  }
}

type MetadataSource = {
  listBranches(project: string): Promise<
    { ref: string; branch: string; revision: string }[]
  >;
  readChangelog(
    project: string,
    ref: string,
  ): Promise<{ entry: { version: string } }>;
};

/**
 * 读一个软件包的元数据。
 *
 * 分支列表一次拿到分支与它当前的提交，再按提交读 changelog —— 共两次请求。
 * 登记的分支在 Gerrit 上不存在就报错：静默跳过会让页面一直显示旧数据。
 */
export async function fetchPackageMetadata(
  gerrit: MetadataSource,
  pkg: { repoPath: string; defaultBranch: string },
): Promise<PackageMetadata> {
  const branches = await gerrit.listBranches(pkg.repoPath);
  const branch = branches.find(
    (item) => item.branch === pkg.defaultBranch || item.ref === pkg.defaultBranch,
  );

  if (!branch) {
    throw new PackageSyncError(
      `Gerrit 仓库 ${pkg.repoPath} 上没有分支 ${pkg.defaultBranch}，请先确认默认分支是否写对。`,
    );
  }

  const { entry } = await gerrit.readChangelog(pkg.repoPath, branch.revision);

  return {
    defaultBranch: branch.branch,
    currentCommit: branch.revision,
    currentVersion: entry.version,
  };
}
