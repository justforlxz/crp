/** `lib/releases` 的公开出口。 */

export {
  evaluateReleaseReadiness,
  summarizeChanges,
  type ReleaseBlocker,
  type ReleaseChangeSummary,
  type ReleaseReadiness,
  type ReleaseReadinessInput,
} from "./plan";

export { buildSnapshotPlan } from "./snapshot";
export type { SnapshotPlan, SnapshotPlanInput } from "./snapshot";

export {
  comparePackageSet,
  parseReleaseInput,
  parseReleaseUpdateInput,
  type ReleaseInput,
  type ReleasePackageInput,
  type ReleaseUpdateInput,
  type ReleaseUpdateOperationInput,
} from "./validation";

export {
  createRelease,
  findReleaseProjectRef,
  listReleaseProjectChoices,
  loadReleaseProject,
  ReleaseError,
  releaseErrorCode,
  type CreateReleaseOptions,
  type CreatedRelease,
  type ReleaseProjectChoice,
  type ReleaseProjectDetail,
  type ReleaseProjectPackage,
} from "./service";

export { createGerritReader, type GerritCommitOption, type GerritReader } from "./gerrit";

export {
  findProjectPackage,
  loadBranchCommits,
  readCommitCodeVersion,
  refreshProjectPackages,
  type PackageRefresh,
  type SelectionResult,
} from "./refresh";

export { canViewRelease, type ReleaseAccessQuery } from "./access";


export {
  abandonReleaseTopic,
  abandonTopicLockReason,
  loadCrpTopicName,
  type AbandonedTopic,
  type AbandonTopicOptions,
} from "./abandon";
export {
  cancelPlatformRelease,
  cancelReleaseLockReason,
  loadCancelableReleaseCount,
  type CancelReleaseLockInput,
  type CancelReleaseOptions,
} from "./cancel";
export { collectDownstream } from "./downstream";

export {
  mapCrpBuildState,
  releaseStatusFromSnapshots,
  type CrpBuildStateMapping,
  type ImportedReleaseStatus,
  type ImportedSnapshotStatus,
} from "./import-map";

export {
  importReleaseFromTopic,
  previewReleaseImport,
  ReleaseImportConflict,
  type ImportedBlockedPackage,
  type ImportedPackagePlan,
  type ImportedRelease,
  type ImportReleaseFromTopicOptions,
  type ReleaseImportOptions,
  type ReleaseImportPreview,
} from "./import";

export {
  applyReleaseUpdate,
  loadReleaseUpdateView,
  previewReleaseUpdate,
  RELEASE_UPDATE_ACTION_LABELS,
  releaseUpdateActionLabel,
  type AbandonedCrpRelease,
  type PlannedRound,
  type PlannedRoundReason,
  type PlannedSnapshot,
  type ReleaseUpdateCandidate,
  type ReleaseUpdateHistoryRow,
  type ReleaseUpdateOptions,
  type ReleaseUpdatePlan,
  type ReleaseUpdatePreviewOptions,
  type ReleaseUpdateResult,
  type ReleaseUpdateView,
  type ReleaseUpdateViewOptions,
} from "./update";

export {
  loadReleaseList,
  loadReleaseProjectOptions,
  parseStatusTab,
  RELEASE_SOURCE_LABELS,
  RELEASE_STATUS_LABELS,
  RELEASE_STATUS_TABS,
  RELEASE_TAB_LABELS,
  RELEASE_TAB_STATUSES,
  releaseSourceLabel,
  releaseStatusLabel,
  releaseStatusPillClass,
  releaseStatusTone,
  type ReleaseListQuery,
  type ReleaseListResult,
  type ReleaseListRow,
  type ReleaseProjectOption,
  type ReleaseStatusTab,
} from "./list";

export {
  buildSnapshotCsv,
  crpTopicUrl,
  loadReleaseDetail,
  SNAPSHOT_COLUMNS,
  snapshotRowCells,
  type CommitInfoReader,
  type GerritCommitInfo,
  type ReleaseDetail,
  type ReleaseDetailHistoryRow,
  type ReleaseDetailOptions,
  type ReleaseDetailPackage,
  type ReleaseDetailRepositoryRecord,
} from "./detail";
