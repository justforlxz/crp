/**
 * 创建提测时对 Gerrit 的读取。
 *
 * 只做「调用 + 整理成页面要的形状」：分支清单、某个分支的提交、某个提交的 changelog 版本。
 * 请求本身全部走 A3 的客户端（`lib/integrations/gerrit`），这里不另发请求、不解析响应体。
 *
 * 客户端可以注入：单测用假实现，不连真实 Gerrit；生产代码不传，按环境变量建一个。
 */

import {
  createGerritClient,
  GerritNotFoundError,
  readGerritConfig,
  type GerritClient,
  type GerritCommit,
} from "../integrations/gerrit";

/** 页面上一个可选提交。只留展示要用的字段，不把整个响应体带到客户端。 */
export type GerritCommitOption = {
  sha: string;
  /** 提交说明首行。 */
  summary: string;
  authorName: string;
  /** 提交时间原样字符串，不做时区换算。 */
  time: string;
};

export type GerritReader = {
  /** 项目全部分支的短名，例如 `develop/eagle`。 */
  listBranches(repoPath: string): Promise<string[]>;
  /** 分支上的提交，从新到旧。 */
  listCommits(repoPath: string, branch: string, limit?: number): Promise<GerritCommitOption[]>;
  /** 某个提交的 `debian/changelog` 版本。 */
  readCodeVersion(repoPath: string, commitSha: string): Promise<string>;
  /** 全部项目的仓库路径；从 CRP 导入时按包名反查仓库用。 */
  listProjects(): Promise<string[]>;
  /**
   * 某个 Tag 指向的提交；这个仓库里没有该 Tag 时返回 `null`。
   *
   * 只有「仓库里没有这个 Tag」才返回 `null`：认证失败、连不上都照常抛错，
   * 否则「读不到」会被当成「没有」，导入会以为是别的原因失败。
   */
  resolveTagCommit(repoPath: string, tag: string): Promise<string | null>;
};

function firstLine(message: string): string {
  const [line] = message.split("\n");
  return line.trim();
}

function toOption(commit: GerritCommit): GerritCommitOption {
  return {
    sha: commit.sha,
    summary: firstLine(commit.message),
    authorName: commit.author.name,
    time: commit.committer.time,
  };
}

/**
 * 用给定（或按环境变量新建）的客户端做读取。
 *
 * 客户端在第一次真正请求时才建：页面渲染阶段不需要 Gerrit 凭据，只有点了「从 Gerrit 刷新」
 * 或提交提测时才读。凭据缺失会在那时抛 `GerritError`，由调用方翻成可读提示。
 */
export function createGerritReader(client?: GerritClient): GerritReader {
  let cached: GerritClient | null = client ?? null;

  function resolve(): GerritClient {
    if (cached === null) {
      cached = createGerritClient(readGerritConfig());
    }

    return cached;
  }

  return {
    async listBranches(repoPath) {
      const branches = await resolve().listBranches(repoPath);

      return branches.map((branch) => branch.branch).sort((left, right) => left.localeCompare(right));
    },

    async listCommits(repoPath, branch, limit) {
      const commits = await resolve().listCommits(repoPath, branch, limit);

      return commits.map(toOption);
    },

    async readCodeVersion(repoPath, commitSha) {
      const { entry } = await resolve().readChangelog(repoPath, commitSha);

      return entry.version;
    },

    listProjects() {
      return resolve().listProjects();
    },

    async resolveTagCommit(repoPath, tag) {
      try {
        const commit = await resolve().resolveTag(repoPath, tag);

        return commit.sha;
      } catch (error) {
        if (error instanceof GerritNotFoundError) {
          return null;
        }

        throw error;
      }
    },
  };
}
