/** `lib/integrations/shuttle` 的公开出口。 */

export { createShuttleClient, ShuttleError } from "./client";
export type { ShuttleClient, ShuttleClientOptions } from "./client";
export { SHUTTLE_DEFAULT_BASE_URL, readShuttleEnv } from "./config";
export type { ShuttleEnv } from "./config";
export { parseAptSourceLine, parseSourcesIndex, sourcesIndexUrl } from "./debIndex";
export type { AptSource } from "./debIndex";
export type {
  BaselinePackage,
  BaselineRepository,
  ShuttleBuildTask,
  ShuttleBuildTaskPage,
  ShuttleJob,
  ShuttleJobLog,
  ShuttleRepoAddress,
  ShuttleRepoInfo,
} from "./types";
