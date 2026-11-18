/**
 * 第二步「检查仓库更新」的数据组装。
 *
 * 与 `gerrit.ts` 的分工：那里只管「调用 Gerrit 拿原始数据」，这里负责「把原始数据拼成页面要的
 * 一行」，并把基线仓库版本（`baseline_package_version` 缓存）带进来。
 *
 * 抽成库函数而不是写在服务端动作里，是为了能直接用假 Gerrit 客户端跑集成测试：
 * 服务端动作那一层只剩权限判定，业务组装全部可测。
 *
 * 一个包读失败只标在它自己身上：仓库路径写错不该让整页都刷不出来，其余包的数据仍然可用。
 */

import { getBaselineVersion } from "../baselines";
import { GerritError } from "../integrations/gerrit";
import { createGerritReader, type GerritCommitOption, type GerritReader } from "./gerrit";
import type { ReleaseProjectDetail, ReleaseProjectPackage } from "./service";

/** 一个软件包在第二步要显示的全部数据。 */
export type PackageRefresh = {
  packageName: string;
  repoPath: string;
  /** 项目清单里的跟踪分支。 */
  trackedBranch: string;
  /** 上次提测成功时提交的 Commit；还没提测过为 `null`。 */
  lastSubmittedCommit: string | null;
  /** 该仓库的全部分支。 */
  branches: string[];
  /** 所选分支的提交，从新到旧。 */
  commits: GerritCommitOption[];
  /** 默认选中的分支与提交，以及该提交的代码版本；读不出来为 `null`。 */
  selected: { branch: string; commitSha: string; codeVersion: string } | null;
  /** 该基线仓库里当前已有的版本；查不到为 `null`。 */
  repoVersion: string | null;
  /** 读不到仓库数据的原因；能读到就是 `null`。读不到会挡住提交。 */
  error: string | null;
  /** 能读到、但需要人看一眼的地方（例如跟踪分支不存在、退到别的分支）；不挡提交。 */
  warning: string | null;
};

/** 切分支 / 切 Commit 的结果。 */
export type SelectionResult = {
  commits: GerritCommitOption[];
  selected: PackageRefresh["selected"];
};

/** 把 Gerrit 的失败翻成能显示的话。 */
function gerritMessage(error: unknown): string {
  if (error instanceof GerritError) {
    return error.message;
  }

  console.error("[releases] 读取 Gerrit 失败", error);
  return "读取 Gerrit 失败，请稍后重试。";
}

/** 在项目清单里按包名找一项；找不到返回 `null`。 */
export function findProjectPackage(
  project: ReleaseProjectDetail,
  packageName: string,
): ReleaseProjectPackage | null {
  return project.packages.find((item) => item.packageName === packageName) ?? null;
}

/**
 * 选默认分支：项目清单里的跟踪分支；它不存在时退回第一个分支。
 *
 * 退回要报告给调用方（`warning`）：静默换成别的分支，会让人以为提测的是原来那条。
 */
function pickBranch(trackedBranch: string, branches: string[]): { branch: string; warning: string | null } {
  if (branches.includes(trackedBranch)) {
    return { branch: trackedBranch, warning: null };
  }

  const fallback = branches[0];

  if (fallback === undefined) {
    return { branch: trackedBranch, warning: null };
  }

  return {
    branch: fallback,
    warning: `项目清单里的跟踪分支 ${trackedBranch} 在仓库里不存在，暂用 ${fallback}。`,
  };
}

/**
 * 列某个分支的提交，并把最新一条的代码版本一并读出来。
 *
 * 切分支后必须重读代码版本：不同分支的 changelog 版本通常不同，
 * 沿用上一个分支的版本会让快照记错版本。
 */
export async function loadBranchCommits(
  repoPath: string,
  branch: string,
  reader: GerritReader = createGerritReader(),
): Promise<SelectionResult> {
  const commits = await reader.listCommits(repoPath, branch);
  const latest = commits[0];

  if (latest === undefined) {
    return { commits, selected: null };
  }

  return {
    commits,
    selected: {
      branch,
      commitSha: latest.sha,
      codeVersion: await reader.readCodeVersion(repoPath, latest.sha),
    },
  };
}

/** 读某个提交的 `debian/changelog` 版本。切 Commit 时用它。 */
export function readCommitCodeVersion(
  repoPath: string,
  commitSha: string,
  reader: GerritReader = createGerritReader(),
): Promise<string> {
  return reader.readCodeVersion(repoPath, commitSha);
}

/**
 * 从 Gerrit 读整个项目的软件包数据。
 *
 * 每个包：列分支 → 定下默认分支 → 列提交 → 读最新提交的代码版本 → 读基线缓存的仓库版本。
 * 单个包失败只记在它自己的 `error` 上，其余包照常返回。
 *
 * 包与包之间彼此独立，一起发出去：逐个 `await` 会让「从 Gerrit 刷新」变成
 * 「包数 × 三次往返」，清单有六个包就是十八轮。
 */
export async function refreshProjectPackages(
  project: ReleaseProjectDetail,
  reader: GerritReader = createGerritReader(),
): Promise<PackageRefresh[]> {
  return Promise.all(
    project.packages.map(async (pkg): Promise<PackageRefresh> => {
      try {
        // 基线缓存与 Gerrit 无关，和列分支一起发出去。
        const [branches, repoVersion] = await Promise.all([
          reader.listBranches(pkg.repoPath),
          getBaselineVersion(project.baseline.id, pkg.packageName),
        ]);
        const { branch, warning } = pickBranch(pkg.trackedBranch, branches);
        const { commits, selected } = await loadBranchCommits(pkg.repoPath, branch, reader);

        return {
          packageName: pkg.packageName,
          repoPath: pkg.repoPath,
          trackedBranch: pkg.trackedBranch,
          lastSubmittedCommit: pkg.lastSubmittedCommit,
          branches,
          commits,
          selected,
          repoVersion,
          error: null,
          warning,
        };
      } catch (error) {
        return {
          packageName: pkg.packageName,
          repoPath: pkg.repoPath,
          trackedBranch: pkg.trackedBranch,
          lastSubmittedCommit: pkg.lastSubmittedCommit,
          branches: [],
          commits: [],
          selected: null,
          repoVersion: null,
          error: gerritMessage(error),
          warning: null,
        };
      }
    }),
  );
}
