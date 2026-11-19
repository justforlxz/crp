/**
 * CRP 接口的请求与响应结构。
 *
 * 分两层：
 * - `CrpRaw*` 是 CRP 的原样响应，字段名用 CRP 自己的 PascalCase，方便对着抓包核对。
 * - 其余是客户端给调用方用的结构，字段名 camelCase，只保留本平台会用到的字段，
 *   完整响应放在 `raw` 里，需要时总能拿到。
 */

/** `GET /branches` 的单项。 */
export type CrpRawBranch = {
  ID: number;
  Name: string;
  Description?: string;
  RepoType?: string;
  IsCheck?: number | boolean;
};

export type CrpBranch = {
  id: number;
  name: string;
  description: string;
  repoType: string;
  /** CRP 侧是否要求检查；数值 1 与布尔 true 都算真。 */
  isCheck: boolean;
  raw: CrpRawBranch;
};

/** `GET /user` 的响应。 */
export type CrpRawUser = {
  Name?: string;
  NameCN?: string;
  Read?: string;
};

export type CrpCurrentUser = {
  /** LDAP 账号，例如 `crp-user`。 */
  name: string;
  /** 中文姓名。 */
  nameCn: string;
  raw: CrpRawUser;
};

/** `POST /project` 响应里的单个项目。 */
export type CrpRawProject = {
  ID: number;
  Name: string;
};

export type CrpProject = {
  id: number;
  name: string;
  raw: CrpRawProject;
};

/** Topic 的 Owner/Members 在响应里是对象数组，在请求里必须是字符串。 */
export type CrpRawTopicOwner = {
  employeeid?: string;
  mail?: string;
  name?: string;
  namecn?: string;
};

/** `GET /topics/{topic_id}` 的原样响应。 */
export type CrpRawTopic = {
  ID: number;
  Name: string;
  NameB64?: string;
  Description?: string;
  BranchID?: number;
  Completed?: boolean;
  Type?: string;
  Abandoned?: boolean;
  Owner?: string | CrpRawTopicOwner[] | null;
  Members?: string | CrpRawTopicOwner[] | null;
  TpcType?: string;
  SyncID?: number;
  State?: number;
  RepoType?: string;
};

/** `POST /branches/{branch_id}/topics` 的响应：实测是一个裸数字（新 Topic 的 ID）。 */
export type CrpCreateTopicInput = {
  name: string;
  branchId: number;
  /** 不传时用当前登录账号做 Owner。 */
  owner?: string;
  description?: string;
  /** `public` 或 `private`，默认 `public`。 */
  tpcType?: string;
  /** 默认 `deb`。 */
  repoType?: string;
};

export type CrpCreatedTopic = {
  topicId: number;
  name: string;
  owner: string;
  /** 原样响应：实测是裸数字，也可能是对象。 */
  raw: unknown;
};

/**
 * `GET /topics/{topic_id}` 整理后的结构。
 *
 * 读回来的 Owner/Members 是对象数组，这里只用 Owner 的账号名；写回时的字符串形式见
 * `namesToString()`，两个方向不能混用。
 */
export type CrpTopic = {
  id: number;
  name: string;
  /** 所属交付分支 ID。主题只能属于一条基线，导入时据它校验项目基线。 */
  branchId: number;
  /** 主题类型，只有 `test` 能承接待投递的 Release。 */
  type: string;
  abandoned: boolean;
  completed: boolean;
  /** CRP 的 `State` 数值，原样保存。 */
  state: number;
  /** Owner 的 LDAP 账号；多人时用 `;` 连接；没有 Owner 时为空串。 */
  owner: string;
  raw: CrpRawTopic;
};

/**
 * `POST /topics/{topic_id}/new_release` 的请求体。
 *
 * 字段名与 CRP 原生一致。`BranchID` 要字符串，`ChangeLogMode` 决定 Tag 由谁决定，
 * 两者都实测过（见 FINDINGS.md），不要因为「看起来像数字」就改成 number。
 */
export type CrpNewReleasePayload = {
  Arches: string;
  BaseTag: string | null;
  Branch: string;
  BuildID: number;
  BuildState: null;
  Changelog: string[];
  Commit: string;
  History: null;
  ID: number;
  ProjectID: number;
  ProjectName: string;
  ProjectRepoUrl: null;
  SlaveNode: null;
  Tag: string;
  TagSuffix: string | null;
  TopicID: number;
  TopicType: string;
  ChangeLogMode: boolean;
  RepoType: string;
  Custom: boolean;
  BranchID: string;
};

export type CrpSubmitReleaseInput = {
  topicId: number;
  /** 软件包仓库名，例如 `dde-file-manager`。 */
  projectName: string;
  /** 仓库分支，例如 `develop/eagle`。 */
  branch: string;
  /** 要投递的提交。 */
  commit: string;
  /** 所属交付分支 ID，createTopic 用的那个。 */
  branchId: number;
  /** 不传时按 projectName + branchId 在 CRP 里查一次。 */
  projectId?: number;
  /**
   * 提测版本号。`changeLogMode` 为 false 时必须给，且只能是
   * 「数字开头、不含 `-`、`_`、空格」的字符串。
   */
  tag?: string;
  /** 默认 false：Tag 用调用方给的版本号。 */
  changeLogMode?: boolean;
  /** 默认空字符串。 */
  changelog?: string;
  /** 默认 `CRP_DEFAULT_ARCHES`。 */
  arches?: string;
  tagSuffix?: string;
  /** 默认 true。 */
  custom?: boolean;
  /** 默认 `deb`。 */
  repoType?: string;
};

export type CrpSubmittedRelease = {
  releaseId: number;
  topicId: number;
  projectId: number;
  projectName: string;
  branch: string;
  commit: string;
  /** 实际发给 CRP 的 Tag。ChangeLogMode 为 true 时 CRP 会忽略它，见 FINDINGS.md。 */
  tag: string;
  changeLogMode: boolean;
  /** 完整请求体，便于审计与复现。 */
  request: CrpNewReleasePayload;
  /** 原样响应：实测是裸数字（Release ID）。 */
  raw: unknown;
};

/** `GET /topics/{topic_id}/releases` 的单项。 */
export type CrpRawRelease = {
  ID: number;
  TopicID: number;
  ProjectID: number;
  ProjectName: string;
  Branch: string;
  Commit: string;
  Tag: string;
  BaseTag?: string;
  Changelog?: string[];
  ChangeLogMode?: boolean;
  BuildID: number;
  BuildState?: { state?: string; log?: string } | null;
  SourcePkgName?: string;
  Status?: number;
  StatusName?: string;
};

export type CrpRelease = {
  /** Release 自己的 ID，删除与重试都用它。 */
  releaseId: number;
  /** 构建任务 ID，查构建日志用它。 */
  buildId: number;
  projectId: number;
  projectName: string;
  branch: string;
  commit: string;
  /** CRP 侧实际生效的版本号。 */
  tag: string;
  /** 构建状态，例如 `APPLYING`、`UPLOAD_FAILED`、`UNKNOWN`。 */
  buildState: string;
  changelog: string[];
  /** CRP 是否按 changelog 生成 Tag（响应里回来的是它自己的取值，不一定是请求里那个）。 */
  changeLogMode: boolean;
  raw: CrpRawRelease;
};

/** `POST /topic_urls` 的请求体。 */
export type CrpTopicUrlsInput = {
  branchId: number;
  topicId: number;
};

export type CrpRawTopicUrls = {
  RepoUrls?: string | string[] | null;
  GitInfo?: unknown;
  OSTree?: unknown;
};

export type CrpTopicUrls = {
  /** 该 Topic 的 apt 仓库地址。构建还没产出时是空数组。 */
  repoUrls: string[];
  raw: CrpRawTopicUrls;
};

/** `GET /topics/{topic_id}/workflow/info` 的原样响应。 */
export type CrpRawWorkflowInfo = {
  ID?: number;
  TopicID?: number;
  TopicName?: string;
  Type?: string;
  WorkProgress?: number;
  TestTableUrl?: string;
  TestUseTableUrl?: string;
  TestReportUrl?: string;
  ReleaseTableUrl?: string;
  AppointUser?: string;
  TestName?: string;
  TestTime?: string;
  TestResult?: boolean;
  TagState?: boolean;
  ReleaseName?: string;
  ReleaseTime?: string;
  ReleaseResult?: boolean;
};

export type CrpTopicWorkflow = {
  topicId: number;
  /** 数值型进度，可直接比较。A17 用它判断「已转测、不可再改包」。 */
  workProgress: number;
  /** 进度对应的中文标签。 */
  workProgressLabel: string;
  /** 已指派的测试/发布管理员。 */
  appointUser: string;
  testTableUrl: string;
  releaseTableUrl: string;
  /** 完整响应。workflow 新建之前，CRP 返回全零对象，原始数据只有这里有。 */
  raw: CrpRawWorkflowInfo;
};
