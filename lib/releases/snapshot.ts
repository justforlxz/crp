/**
 * 提测快照的组装规则。
 *
 * 纯函数：输入是「这个包选中的分支、Commit、changelog 版本、基线仓库版本、自定义 Tag」，
 * 输出是直接写进 `release_package_snapshot` 的一行。规则只有一份，页面预览与接口写库共用。
 *
 * 三个版本号的含义（PRD 第二节）：
 *
 * | 字段 | 来源 |
 * | --- | --- |
 * | `codeVersion` | 所选 Commit 的 `debian/changelog` 首条版本，原样保留 |
 * | `repoVersion` | 该基线交付仓库里当前已有的版本，查不到为空 |
 * | `releaseVersion` | 本次提交给 CRP 的版本（Tag）：填了自定义 Tag 就是它，否则等于代码版本 |
 *
 * 自定义 Tag 只有一个字段：设置了它，提测版本就是它本身，不再另设「自定义仓库版本」。
 * `repoVersion` 永远来自基线缓存，不因为设置了 Tag 而改变 —— AC3 就是按这条验的。
 */

/** 一个软件包快照的输入。 */
export type SnapshotPlanInput = {
  /** 源码包名。 */
  packageName: string;
  /** 固化的分支。 */
  branch: string;
  /** 固化的 Commit。 */
  commitSha: string;
  /** 所选 Commit 的 `debian/changelog` 版本。 */
  codeVersion: string;
  /** 基线交付仓库里当前已有的版本；查不到为 `null`。 */
  repoVersion: string | null;
  /** 自定义 Tag；没填为 `null` 或空串。 */
  customTag: string | null;
  /** 上次提测成功时提交的 Commit；还没提测过为 `null`。 */
  lastSubmittedCommit: string | null;
};

/** 一行快照，字段与 `release_package_snapshot` 的列一一对应。 */
export type SnapshotPlan = {
  packageName: string;
  /** 该包在这个提测里的第几轮；A11 建提测一律是第 1 轮。 */
  attempt: number;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  /** Commit 与上次提测不同（或从未提测过）。只作提示，不影响是否纳入。 */
  changed: boolean;
};

/** 自定义 Tag 去空白后为空即视为没填。 */
function normalizeCustomTag(customTag: string | null): string | null {
  if (customTag === null) {
    return null;
  }

  const text = customTag.trim();
  return text === "" ? null : text;
}

/**
 * 组装一行快照。
 *
 * `attempt` 固定为 1：本节点只创建新提测，补包换包走 A17 的追加轮次。
 * 提测版本与代码版本分开存，正是为了让「自定义 Tag 覆盖提测版本」时还能查到真实的代码版本。
 */
export function buildSnapshotPlan(input: SnapshotPlanInput): SnapshotPlan {
  const customTag = normalizeCustomTag(input.customTag);

  return {
    packageName: input.packageName,
    attempt: 1,
    branch: input.branch,
    commitSha: input.commitSha,
    codeVersion: input.codeVersion,
    repoVersion: input.repoVersion,
    releaseVersion: customTag ?? input.codeVersion,
    changed: input.lastSubmittedCommit !== input.commitSha,
  };
}
