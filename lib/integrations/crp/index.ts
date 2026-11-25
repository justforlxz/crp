/** CRP 客户端对外的入口：在 `lib/` 之外只从这里 import。 */

export {
  createCrpClient,
  createCrpClientForCurrentUser,
  createCrpClientForUser,
  type CrpClient,
  type CrpClientOptions,
} from "./client";
export type {
  CrpRequestObservation,
  CrpRequestObserver,
  CrpTransport,
  CrpTransportOptions,
} from "./request";
export {
  CRP_DEFAULT_BASE_URL,
  CRP_DEFAULT_RETRIES,
  CRP_DEFAULT_TIMEOUT_MS,
  CRP_ENV,
  readCrpConfig,
  readCrpSettings,
  type CrpConfig,
  type CrpSettings,
} from "./config";
export {
  clearAllCachedTokens,
  clearCachedToken,
  readCachedToken,
  writeCachedToken,
} from "./tokenCache";
export {
  CrpAuthError,
  CrpBusinessError,
  CrpError,
  CrpInvalidParameterError,
  CrpNetworkError,
  CrpRateLimitedError,
  responseSnippet,
  type CrpErrorKind,
} from "./errors";
export { toCrpArches, toCrpArchList } from "./arches";
export { validateReleaseTag } from "./tag";
export { pickExactProject, resolveProjectId, searchProjects } from "./projects";
export {
  getTopic,
  normalizeTopic,
  searchTopics,
  topicOwnedBy,
  TOPIC_SEARCH_LIMIT,
  type CrpTopicSearchResult,
} from "./topics";
export {
  normalizeTopicWorkflow,
  WORK_PROGRESS,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  workProgressLabel,
} from "./workflow";
export type {
  CrpBranch,
  CrpCreateTopicInput,
  CrpCreatedTopic,
  CrpCurrentUser,
  CrpNewReleasePayload,
  CrpProject,
  CrpRawBranch,
  CrpRawProject,
  CrpRawRelease,
  CrpRawTopic,
  CrpRawTopicOwner,
  CrpRawTopicUrls,
  CrpRawUser,
  CrpRawWorkflowInfo,
  CrpRelease,
  CrpSubmitReleaseInput,
  CrpSubmittedRelease,
  CrpTopic,
  CrpTopicUrls,
  CrpTopicWorkflow,
} from "./types";
