/**
 * Gerrit 与 gitiles 客户端的对外入口。
 *
 * 职责边界（见上层 README）：只做「调用 + 返回结构化数据」，
 * 不判定提测版本规则、不写数据库、不与 CRP 交互。
 */

export {
  ChangelogParseError,
  parseChangelog,
  type ChangelogEntry,
} from "./changelog";

export {
  createGerritClient,
  encodeGitilesRef,
  isCommitSha,
  GerritAuthError,
  GerritError,
  GerritNotFoundError,
  MAX_COMMITS,
  normalizeRef,
  readGerritConfig,
  stripGerritPrefix,
  type GerritBranch,
  type GerritClient,
  type GerritClientOptions,
  type GerritCommit,
  type GerritConfig,
  type GerritPerson,
} from "./client";
