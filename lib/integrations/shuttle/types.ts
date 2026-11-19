/** Shuttle 客户端对外暴露的数据结构。 */

/** 基线仓库里的一个软件包及其当前版本。软件包指源码包，例如 `kwin`。 */
export type BaselinePackage = {
  name: string;
  version: string;
};

/** 一条构建作业，对应一个架构上的编译。 */
export type ShuttleJob = {
  id: number;
  arch: string;
  status: string;
};

/** 一条构建任务，对应 `POST /task/list` 返回的 `tasks[]` 元素。 */
export type ShuttleBuildTask = {
  key: number;
  pkgname: string;
  pkgver: string;
  reponame: string;
  action: string;
  status: string;
  statusChanged: string;
  username: string;
  pkgtype: string;
  jobs: ShuttleJob[];
};

/** `POST /task/list` 的分页返回。 */
export type ShuttleBuildTaskPage = {
  tasks: ShuttleBuildTask[];
  total: number;
};

/** `GET /job/log` 的返回。`log` 是原始日志文本，不做解析。 */
export type ShuttleJobLog = {
  jobId: number;
  log: string;
};

/** `GET /repo/info` 里本仓库自己的仓库地址。`name` 取 `release`、`commit`、`release-candidate`。 */
export type ShuttleRepoAddress = {
  name: string;
  address: string;
};

/** `GET /repo/info` 中本客户端用到的字段。 */
export type ShuttleRepoInfo = {
  reponame: string;
  repotype: string;
  addresses: ShuttleRepoAddress[];
  /**
   * 这条基线的提测仓库（`repoarch["release-candidate"]`）对外发布的架构列表，原样保留。
   *
   * 含 `source` 这类不是 CPU 架构的项，改名与去项由使用方决定（投递要按 CRP 的实测口径
   * 转换，见 `lib/integrations/crp/arches.ts`）。
   */
  arches: string[];
};

/** 一条基线的仓库快照：仓库信息与仓库索引里的软件包版本，一次取回。 */
export type BaselineRepository = {
  info: ShuttleRepoInfo;
  packages: BaselinePackage[];
};
