/**
 * 创建提测向导共用的数据形状与一个小函数。
 *
 * 单独放一个文件，是为了让向导外壳与三步的子组件互不引用：外壳引用子组件，
 * 子组件只从这里取类型，不会出现「外壳 → 子组件 → 外壳」的循环引用。
 */

/** 一个软件包当前的选择。 */
export type Selection = {
  branch: string;
  commitSha: string;
  /** 所选 Commit 的 changelog 版本。 */
  codeVersion: string;
  /** 自定义 Tag；空串表示没填。 */
  customTag: string;
};

/** 提交成功后的返回体（`POST /api/releases` 的 201）。 */
export type SubmitResult = {
  id: string;
  version: string;
  revision: number;
  packageCount: number;
  changedCount: number;
  summary: string;
  order: string[];
  snapshots: Array<{
    packageName: string;
    branch: string;
    commitSha: string;
    codeVersion: string;
    repoVersion: string | null;
    releaseVersion: string;
    changed: boolean;
  }>;
};

export type Step = 1 | 2 | 3;

/** 表格里显示提交号只取前 12 位，完整提交号太长会把表格撑开。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
