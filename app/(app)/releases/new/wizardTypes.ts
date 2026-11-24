/**
 * 创建提测向导共用的数据形状与几个小函数。
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

/** 第 2 步表格上方的更新状态筛选（原型 `.wiz-toolbar` 的下拉）。 */
export type WizardFilter = "all" | "yes" | "no";

/** 三步的名字。顺序固定，步骤条与页头都用这一份（design.md 第八节）。 */
export const WIZARD_STEPS: ReadonlyArray<{ step: Step; title: string }> = [
  { step: 1, title: "项目归属" },
  { step: 2, title: "检查仓库更新" },
  { step: 3, title: "确认提测" },
];

/** 表格里显示提交号只取前 12 位，完整提交号太长会把表格撑开。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** 基线状态 → 状态点的档位。判定口径与 `lib/baselines/status.ts` 一致。 */
export function baselineTone(state: string): string {
  if (state === "synced") {
    return "is-ok";
  }

  if (state === "failed" || state === "missing") {
    return "is-bad";
  }

  return "is-wait";
}
