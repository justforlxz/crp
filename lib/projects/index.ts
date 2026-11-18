/** `lib/projects` 的公开出口。 */

export { canViewProject } from "./access";
export type { ProjectAccessQuery } from "./access";

export { baselineBlockReason } from "./baselineGate";
export type { BaselineGateInput } from "./baselineGate";

export { buildSoftwareView } from "./softwareView";
export type { SoftwareEntry, SoftwareView } from "./softwareView";

export {
  joinFieldErrors,
  parseManagerInput,
  parseProjectInput,
  parseProjectSoftwareInput,
} from "./validation";
export type {
  FieldError,
  ManagerInput,
  ParseResult,
  ProjectInput,
  ProjectSoftwareInput,
} from "./validation";

export {
  addProjectSoftware,
  copyProject,
  createManager,
  createProject,
  findManagerRef,
  findProjectRef,
  getProject,
  listBaselineChoices,
  listManagers,
  listPackageChoices,
  listProjectCards,
  ProjectError,
  removeProjectSoftware,
  renameManager,
  softDeleteProject,
  updateProject,
  updateProjectSoftwareBranch,
} from "./service";
export type { ProjectCard } from "./service";
