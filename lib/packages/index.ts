/** `lib/packages` 的公开出口。 */

export { findDependencyCycle, formatCycle, sortByDependencies } from "./dependencyGraph";
export type { DependencyEdge, TopologicalSort } from "./dependencyGraph";

export {
  CRP_PROJECT_NAME_MAX_LENGTH,
  CrpProjectNameError,
  describeCrpProjectName,
  isValidCrpProjectName,
  resolveCrpProjectName,
} from "./crpProject";
export type { CrpProjectNameSource } from "./crpProject";
export { MAX_PAYLOAD_ITEMS, parsePackageInput, parsePackagePayload } from "./validation";
export type { FieldError, PackageInput, ParseResult } from "./validation";

export {
  createPackage,
  deletePackage,
  getPackageDetail,
  listBaselineOptions,
  listPackages,
  PackageError,
  saveDependencies,
  syncPackageMetadata,
  updatePackage,
  upsertPackages,
} from "./service";
export type { UpsertResult } from "./service";

export { fetchPackageMetadata, PackageSyncError } from "./sync";
export type { PackageMetadata } from "./sync";

export { fetchBaselineVersion } from "./baselineVersion";
export type { BaselineVersionQuery } from "./baselineVersion";

export {
  checkPackageApiAuth,
  PACKAGE_API_TOKEN_ENV,
  readPackageApiToken,
} from "./apiAuth";
export type { ApiAuthResult } from "./apiAuth";

export {
  createSearchCache,
  CRP_ANY_BRANCH_ID,
  CRP_RESULT_CAP,
  CrpProjectSearchError,
  normalizeQuery,
  parseBranchId,
  parseLimit,
  searchCrpProjects,
  SEARCH_CACHE_CAPACITY,
  SEARCH_CACHE_TTL_MS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  sortSearchItems,
  toSearchError,
  toSearchItems,
} from "./crpSearch";
export type {
  CrpProjectFetcher,
  CrpProjectSearchCache,
  CrpProjectSearchCacheEntry,
  CrpProjectSearchDeps,
  CrpProjectSearchInput,
  CrpProjectSearchItem,
  CrpProjectSearchResult,
} from "./crpSearch";

export { repoPathFromRepoUrl } from "./repoUrl";
