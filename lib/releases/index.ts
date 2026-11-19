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

export { collectDownstream } from "./downstream";

export {
  applyReleaseUpdate,
  loadReleaseUpdateView,
  previewReleaseUpdate,
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
