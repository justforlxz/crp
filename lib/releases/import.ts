/**
 * 从 CRP 导入已有的提测主题（A18）。
 *
 * 同事在 CRP 上直接建的主题、以及历史遗留的主题，不必在本平台重头再建一次：
 * 选一个项目作为归属，把主题里已有的 Release 接管成本地提测记录与快照，
 * 之后改包、补包走 A17 的增量更新，能力与平台创建的提测完全一样。
 *
 * 五条规则决定了这里的形状：
 *
 * 1. **零写入 CRP**：本模块只调 `getTopic`、`listReleases`、`getTopicWorkflow` 三个读接口，
 *    不建 Topic、不投递、不删除、不重试。导入前后 CRP 侧应当分毫未动。
 * 2. **提测版本取自 CRP Release 的 `tag`**，逐字保存，不重算、也不用 changelog 版本顶替。
 * 3. **Commit 必须有着落**：先取 CRP Release 里的 `Commit`（要能当提交号用，CRP 对预置
 *    deb 会填 `uploadcrp` 这种占位值）；取不到就按 `tag` 去 Gerrit 反查该 Tag 指向的提交；
 *    两条都拿不到，整次导入停在预览步骤并点名是哪几个包，绝不留空 Commit 进快照。
 * 4. **映射不许猜**：CRP 给的 `ProjectName` 是**CRP 项目名**，既不是本地包名也不是仓库路径。
 *    先按软件包的 `crpProjectName` 精确匹配、再按包名兜底（`mapCrpProjectNames`）；
 *    命中不止一个包按映射歧义停手，一个都没命中才去 Gerrit 找「最后一段同名且提交确实在里面」
 *    的唯一仓库，否则停手，让人先去登记。
 * 5. **幂等**：`release.crp_topic_id` 唯一，同一主题只能导入一次；重复导入提示并跳到已有记录。
 *
 * 判定与落库分开：`previewReleaseImport()` 与 `importReleaseFromTopic()` 走同一个计划函数，
 * 页面看到的就是服务端要做的。
 */

import type { BuildNetwork } from "../build";
import { prisma } from "../db";
import {
  createCrpClient,
  createCrpClientFromEnv,
  CRP_DEFAULT_BASE_URL,
  CrpError,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  type CrpClient,
  type CrpRelease,
  type CrpTopic,
} from "../integrations/crp";
import { GerritError, GerritNotFoundError, isCommitSha } from "../integrations/gerrit";
import { createGerritReader, type GerritReader } from "./gerrit";
import {
  mapCrpBuildState,
  releaseStatusFromSnapshots,
  type ImportedReleaseStatus,
  type ImportedSnapshotStatus,
} from "./import-map";
import { loadReleaseProject, ReleaseError, type ReleaseProjectDetail } from "./service";

/** 导入只用到这三个 CRP 读接口，别的一律不碰（MUST 零写入 CRP）。 */
type ImportCrpApis = Pick<CrpClient, "getTopic" | "listReleases" | "getTopicWorkflow">;

/** 只有 `test` 类型的主题能承接待投递的 Release。 */
const IMPORTABLE_TOPIC_TYPE = "test";

/**
 * **本地**软件包名与 `package.name` 同一套规则：小写字母开头，只允许小写字母、数字与 `+` `-` `.`。
 *
 * 只用来校验「要写进 `package.name` 的名字」。**不要**拿它去套 CRP 的 `project_name`：
 * CRP 的项目名允许下划线（`deepin-kde/kwin`、`deepin-kde/wayland` 在 CRP 上就只有带下划线的项目名），
 * 套上去会把合法的项目名判成非法。CRP 项目名怎么落回本地包，见 `mapCrpProjectNames`。
 */
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export type ReleaseImportOptions = {
  /** 提测归属的项目。 */
  projectId: string;
  /** CRP 侧的主题 ID。 */
  topicId: number;
  /** 读 Gerrit 用；单测注入假实现，生产代码不传，按环境变量建。 */
  reader?: GerritReader;
  /** 注入用的网络接线，与 A12 / A17 同一形状。 */
  network?: BuildNetwork;
};

export type ImportReleaseFromTopicOptions = ReleaseImportOptions & {
  /** 发起人，取自会话。 */
  createdById: string;
  /** 是否把这些包一并加入项目软件清单。默认不勾，不影响导入本身。 */
  addPackagesToProject?: boolean;
};

/** 预览里的一行：一个 CRP Release 对应的本地快照该怎么写。 */
export type ImportedPackagePlan = {
  /**
   * 落回本地的包名，也是写进快照的 `packageName`：命中登记的软件包时是它的 `name`（Debian 源码包名），
   * 未登记时等于 CRP 的 `project_name`。投递时再由 `crpProjectName` 解析出 CRP 项目名。
   */
  packageName: string;
  /** 已登记软件包的 ID；`null` 表示这次导入会顺手建一条软件包记录。 */
  packageId: string | null;
  /** 从 Gerrit 定下来的仓库路径。 */
  repoPath: string;
  branch: string;
  commitSha: string;
  /** Commit 的来源：CRP Release 自带，或按 Tag 在 Gerrit 反查到的。 */
  commitSource: "crp" | "gerrit-tag";
  /** 该 Commit 的 `debian/changelog` 版本。 */
  codeVersion: string;
  /** 基线交付仓库里当前已有的版本，查不到为空。 */
  repoVersion: string | null;
  /** 提测版本，逐字取自 CRP Release 的 `tag`。 */
  releaseVersion: string;
  /** CRP Release ID，导入后写进 `release_repository_record`。 */
  crpReleaseId: string;
  /** CRP Release 的 `BuildID`；为 0 时是 `null`。 */
  crpBuildId: string | null;
  /** CRP 原样的构建状态，预览里直接展示。 */
  buildState: string;
  /** CRP 的这个状态在映射表里；`false` 表示没见过的状态。 */
  buildStateKnown: boolean;
  /** 关于状态的说明；无需提示时为 `null`。 */
  buildStateNote: string | null;
  status: ImportedSnapshotStatus;
  /** 提测版本与代码版本不同：往往正是需要改包的原因。 */
  versionMismatch: boolean;
};

/** 卡住的包：预览里标红，整次导入不得放行。 */
export type ImportedBlockedPackage = {
  packageName: string;
  /** 为什么卡住，直接显示给人看。 */
  reason: string;
};

/** 一个主题的导入预览。 */
export type ReleaseImportPreview = {
  project: {
    id: string;
    key: string;
    name: string;
    baselineId: string;
    baselineName: string;
  };
  topic: {
    id: number;
    name: string;
    /** 主题所在的 CRP 交付分支 ID 与分支名。 */
    branchId: number;
    branchName: string;
    owner: string;
    type: string;
    abandoned: boolean;
    completed: boolean;
  };
  packages: ImportedPackagePlan[];
  blocked: ImportedBlockedPackage[];
  /** 已导入过这个主题时的已有记录；同一主题只能导入一次。 */
  existing: {
    releaseId: string;
    version: string;
    projectId: string;
    projectName: string;
  } | null;
  /** 能不能继续导入：没有卡住的包，且这个主题还没被导入过。 */
  ready: boolean;
};

/** 导入成功的结果。 */
export type ImportedRelease = {
  releaseId: string;
  version: string;
  revision: number;
  status: ImportedReleaseStatus;
  /** 每个包写下的快照，顺序与 CRP 侧一致。 */
  packages: ImportedPackagePlan[];
  /** 这次自动登记成软件包记录的包名。 */
  autoRegisteredPackages: string[];
  /** 这次一并加入项目软件清单的包名；没勾就是空数组。 */
  addedToProject: string[];
  /** 导入后现读的 CRP 工作流进度。 */
  workProgress: number | null;
  workProgressLabel: string | null;
  /** 读不到进度时的原因；读到就是 `null`。 */
  workProgressError: string | null;
  /** 已转测：A17 的「更新提测」对这条记录不可用。 */
  locked: boolean;
};

/**
 * 同一主题重复导入。带上已有记录的 ID，接口把它放进响应，页面据此跳到那条记录。
 */
export class ReleaseImportConflict extends ReleaseError {
  readonly existingReleaseId: string;
  readonly existingVersion: string;

  constructor(message: string, existing: { releaseId: string; version: string }) {
    super(message, 409);
    this.name = "ReleaseImportConflict";
    this.existingReleaseId = existing.releaseId;
    this.existingVersion = existing.version;
  }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 提测要挂的项目：存在、没删。 */
async function loadUsableProject(projectId: string): Promise<ReleaseProjectDetail> {
  const project = await loadReleaseProject(projectId);

  if (project === null) {
    throw new ReleaseError("项目不存在。", 404);
  }

  if (project.deletedAt !== null) {
    throw new ReleaseError("项目已删除，不能导入提测。历史提测记录仍可查看。", 409);
  }

  return project;
}

/** 建 CRP 客户端；单测用注入的 `fetch`，生产按环境变量。 */
function resolveCrp(network: BuildNetwork | undefined): ImportCrpApis {
  if (network?.crpFetch === undefined) {
    return createCrpClientFromEnv(process.env);
  }

  return createCrpClient({
    baseUrl: network.crpBaseUrl ?? CRP_DEFAULT_BASE_URL,
    token: network.crpToken ?? "injected",
    tokenPath: null,
    fetchImpl: network.crpFetch,
  });
}

/** 把 CRP 客户端的失败翻成能显示的话；401 与网络问题都归到这里。 */
async function callCrp<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReleaseError) {
      throw error;
    }

    const message = error instanceof CrpError ? error.message : String(error);
    console.error(`[releases] 导入时${what}失败`, error);
    throw new ReleaseError(`读取 CRP 失败（${what}）：${message}`, 502);
  }
}

/** 主题所在交付分支的名字。库里没有这条基线时退回分支 ID，不额外发请求。 */
async function readBranchName(branchId: number): Promise<string> {
  const baseline = await prisma.baseline.findUnique({
    where: { crpBranchId: String(branchId) },
    select: { name: true },
  });

  return baseline?.name ?? `分支 ID ${branchId}`;
}

/**
 * 主题能不能导入这个项目：类型、状态、分支三条硬条件。
 *
 * 分支必须与项目基线一致（MUST）：不一致就指名道姓地说清是哪两个，不让人自己猜。
 */
async function assertTopicImportable(
  crp: ImportCrpApis,
  project: ReleaseProjectDetail,
  topicId: number,
): Promise<{ topic: CrpTopic; branchName: string }> {
  const topic = await callCrp("读主题", () => crp.getTopic(topicId));

  if (topic.type !== IMPORTABLE_TOPIC_TYPE) {
    throw new ReleaseError(
      `只支持导入 ${IMPORTABLE_TOPIC_TYPE} 类型的主题，这个主题的类型是「${topic.type || "空"}」。`,
      400,
    );
  }

  if (topic.abandoned) {
    throw new ReleaseError(`主题「${topic.name}」已经在 CRP 上被放弃，不能导入。`, 409);
  }

  const baseline = await prisma.baseline.findUnique({
    where: { id: project.baseline.id },
    select: { crpBranchId: true, name: true },
  });

  const topicBranchName = await readBranchName(topic.branchId);
  const projectBranchId = baseline?.crpBranchId ?? "";

  if (String(topic.branchId) !== projectBranchId) {
    throw new ReleaseError(
      `主题在 CRP 分支「${topicBranchName}」（ID ${topic.branchId}），` +
        `项目基线是「${project.baseline.name}」（ID ${projectBranchId || "未知"}），两者不一致，不能导入。`,
      409,
    );
  }

  return { topic, branchName: topicBranchName };
}

/**
 * 已导入过这个主题的本地记录；没有就是 `null`。
 *
 * 按 `crp_topic_id` 查，不带项目条件：同一个主题不许导入两个项目（MUST），
 * 幂等的落点就是这一列的唯一约束。
 */
async function findExistingImport(topicId: number): Promise<{
  releaseId: string;
  version: string;
  projectId: string;
  projectName: string;
} | null> {
  const release = await prisma.release.findUnique({
    where: { crpTopicId: String(topicId) },
    select: {
      id: true,
      version: true,
      projectId: true,
      project: { select: { name: true } },
    },
  });

  if (release === null) {
    return null;
  }

  return {
    releaseId: release.id,
    version: release.version,
    projectId: release.projectId,
    projectName: release.project.name,
  };
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

/** 一次导入的完整结论，预览与落库共用。 */
type ImportPlan = {
  project: ReleaseProjectDetail;
  topic: CrpTopic;
  branchName: string;
  packages: ImportedPackagePlan[];
  blocked: ImportedBlockedPackage[];
  existing: ReleaseImportPreview["existing"];
};

/**
 * `deepin-kde/kwin` → `kwin`。
 *
 * 只用来给**还没登记**的包找候选仓库（「Gerrit 上最后一段同名」），不是「CRP 项目名就是包名」的断言：
 * CRP 的项目名与仓库路径的最后一段不一定相同（`deepin-kde/kwin` 在 CRP 上就不叫 `kwin`），
 * 所以已登记的包一律走 `crpProjectName` 映射，不靠这个后缀猜。
 */
function lastSegment(repoPath: string): string {
  const parts = repoPath.split("/");
  return parts.at(-1) ?? "";
}

/**
 * 在几个候选仓库里把「Commit + 仓库路径 + 代码版本」一起定下来。
 *
 * 一次读 changelog 同时完成两件事：证明这个提交确实在这个仓库里，并取到它的代码版本。
 * 结果为空表示一个都没定下来；不止一个表示候选仓库里都存在这个提交，属于不确定，不许挑一个用。
 */
async function locateCommit(
  candidates: readonly string[],
  input: { crpCommit: string | null; tag: string },
  reader: GerritReader,
): Promise<
  Array<{ repoPath: string; commitSha: string; commitSource: "crp" | "gerrit-tag"; codeVersion: string }>
> {
  const found = [];

  for (const repoPath of candidates) {
    // CRP 给了可用提交号就用它；没有就按 Tag 在这个仓库里反查。
    let commitSha = input.crpCommit;
    let commitSource: "crp" | "gerrit-tag" = "crp";

    if (commitSha === null) {
      const resolved = await reader.resolveTagCommit(repoPath, input.tag);

      if (resolved === null) {
        continue;
      }

      commitSha = resolved;
      commitSource = "gerrit-tag";
    }

    let codeVersion: string;

    try {
      codeVersion = await reader.readCodeVersion(repoPath, commitSha);
    } catch (error) {
      if (error instanceof GerritNotFoundError) {
        // 提交不在这个仓库：说明这个候选仓库不对，继续看下一个。
        continue;
      }

      throw toGerritError(error, repoPath);
    }

    found.push({ repoPath, commitSha, commitSource, codeVersion });
  }

  return found;
}

/** Gerrit 的失败翻成能显示的话。 */
function toGerritError(error: unknown, repoPath: string): ReleaseError {
  if (error instanceof ReleaseError) {
    return error;
  }

  if (error instanceof GerritError) {
    return new ReleaseError(`读取仓库「${repoPath}」的代码版本失败：${error.message}`, 502);
  }

  console.error(`[releases] 读取仓库 ${repoPath} 失败`, error);
  return new ReleaseError(`读取仓库「${repoPath}」的代码版本失败，请稍后重试。`, 502);
}

/** 落回本地之后的样子：登记过的软件包行。 */
type LocalPackage = { id: string; name: string; repoPath: string };

/**
 * CRP 项目名落回本地软件包的结果。
 *
 * `resolved` 是唯一命中的包；`ambiguous` 是命中不止一个包的 CRP 项目名 ——
 * 此时「该落回哪个包」没有唯一答案，导入必须停手，不许挑一个用。
 */
type CrpProjectMapping = {
  resolved: Map<string, LocalPackage>;
  ambiguous: Map<string, string[]>;
};

/**
 * 把 CRP 的 `project_name` 映射成本地软件包：**CRP 项目名优先、包名兜底**。
 *
 * 两个方向都要对，所以这一条规则只有一份实现：
 * - CRP 项目名（`package.crp_project_name`）是为了「包名与 CRP 项目名不同」的情况（本缺陷的由来）；
 * - 包名兜底是为了「没填这一列」的历史数据：留空表示与包名相同，行为与本列出现之前一致。
 *
 * 两种匹配落到**不同的**包上时按映射歧义处理：同一份数据同时说「这个项目是 A」和「这个项目是 B」，
 * 挑一个用会把提测挂到错误的包上，而 CRP 侧的 Release 是对的，问题只能靠人比对发现。
 */
async function mapCrpProjectNames(
  projectNames: readonly string[],
): Promise<CrpProjectMapping> {
  const resolved: CrpProjectMapping["resolved"] = new Map();
  const ambiguous: CrpProjectMapping["ambiguous"] = new Map();

  if (projectNames.length === 0) {
    return { resolved, ambiguous };
  }

  const rows = await prisma.package.findMany({
    where: {
      OR: [
        { crpProjectName: { in: [...projectNames] } },
        { name: { in: [...projectNames] } },
      ],
    },
    select: { id: true, name: true, repoPath: true, crpProjectName: true },
  });

  for (const projectName of projectNames) {
    const hits = new Map<string, LocalPackage>();

    for (const row of rows) {
      if (row.crpProjectName === projectName || row.name === projectName) {
        hits.set(row.id, { id: row.id, name: row.name, repoPath: row.repoPath });
      }
    }

    if (hits.size === 1) {
      const only = [...hits.values()][0];
      resolved.set(projectName, only);
      continue;
    }

    if (hits.size > 1) {
      ambiguous.set(
        projectName,
        [...hits.values()].map((row) => row.name).sort(),
      );
    }
  }

  return { resolved, ambiguous };
}

/**
 * 一个 CRP 项目名在本地叫什么包名：命中登记的包就是它的 `name`，否则只能是 CRP 项目名本身。
 *
 * 快照存的是本地包名（投递时再解析成 CRP 项目名），所以先用它算「快照会写下的包名」。
 */
function localPackageNameOf(projectName: string, mapping: CrpProjectMapping): string {
  return mapping.resolved.get(projectName)?.name ?? projectName;
}

/** 一个包在哪个仓库里，候选集合怎么来。已登记的拿现成的，未登记的去 Gerrit 按名字找。 */
async function loadRepoCandidates(
  projectNames: readonly string[],
  mapping: CrpProjectMapping,
  reader: GerritReader,
): Promise<{
  registered: Map<string, LocalPackage>;
  candidates: Map<string, string[]>;
}> {
  const needProjects = projectNames.some((name) => !mapping.resolved.has(name));

  // 只有真遇到未登记的包才去列项目：已登记的情况下这份清单没有用处。
  const projects = needProjects ? await listGerritProjects(reader) : [];

  const candidates = new Map<string, string[]>();

  for (const projectName of projectNames) {
    const known = mapping.resolved.get(projectName);

    if (known !== undefined) {
      candidates.set(projectName, [known.repoPath]);
      continue;
    }

    candidates.set(
      projectName,
      projects.filter((repoPath) => lastSegment(repoPath) === projectName),
    );
  }

  return { registered: mapping.resolved, candidates };
}

/** 列全部项目路径；失败就抛错，不拿空清单当真。 */
async function listGerritProjects(reader: GerritReader): Promise<string[]> {
  try {
    return await reader.listProjects();
  } catch (error) {
    throw toGerritError(error, "全部项目清单");
  }
}

/** 把一条 CRP Release 定成一个快照计划；定不下来就说明原因。 */
async function planPackage(
  input: {
    release: CrpRelease;
    /**
     * 落回本地时用的包名：命中登记的软件包就是它的 `name`，否则等于 CRP 项目名（未登记，可能自动登记）。
     */
    packageName: string;
    registered: LocalPackage | undefined;
    candidates: readonly string[];
    repoVersion: string | null;
  },
  reader: GerritReader,
): Promise<{ plan: ImportedPackagePlan } | { blocked: ImportedBlockedPackage }> {
  const { release, packageName, registered, candidates, repoVersion } = input;

  const blocked = (reason: string): { blocked: ImportedBlockedPackage } => ({
    blocked: { packageName: packageName === "" ? `Release ${release.releaseId}` : packageName, reason },
  });

  if (packageName === "") {
    return blocked("CRP Release 没有软件包名（project_name 为空），无法对应到仓库。");
  }

  // 只有「要写进 package.name 的名字」才套 Debian 包名规则：
  // 已登记的包名早就校验过，未登记的才会拿 CRP 项目名当包名建记录，那一步必须拦下不合规的名字。
  if (registered === undefined && !PACKAGE_NAME_PATTERN.test(packageName)) {
    return blocked(
      `CRP 项目名「${packageName}」不是合法的 Debian 包名（小写字母开头，只允许小写字母、数字与 + - .），` +
        "无法自动登记成本地软件包。请先在软件包管理里登记这个包，并在「CRP 项目名」里填上它。",
    );
  }

  if (release.tag.trim() === "") {
    return blocked("CRP Release 没有提测版本（tag 为空），提测版本必须取自 CRP 的 tag。");
  }

  if (release.branch.trim() === "") {
    return blocked("CRP Release 没有分支，无法确定快照的分支与软件包的默认分支。");
  }

  if (candidates.length === 0) {
    return blocked("仓库路径未知，请先在软件包管理登记后再导入。");
  }

  // CRP 对预置 deb 会填 `uploadcrp` 这类占位值，它不是提交号，当作「没有 Commit」。
  const crpCommit = isCommitSha(release.commit.trim()) ? release.commit.trim() : null;
  const located = await locateCommit(candidates, { crpCommit, tag: release.tag }, reader);

  if (located.length === 0) {
    const reason =
      crpCommit === null
        ? `拿不到 Commit：CRP Release 的提交是「${release.commit || "空"}」，` +
          `按 Tag「${release.tag}」在 Gerrit 的 ${candidates.join("、")} 里也反查不到。`
        : `拿不到 Commit：${crpCommit} 在 Gerrit 的 ${candidates.join("、")} 里读不到 debian/changelog。`;

    return blocked(reason);
  }

  if (located.length > 1) {
    return blocked(
      `仓库路径不确定：${candidates.join("、")} 里都能找到这个提交，` +
        "请先在软件包管理登记这个包，指定唯一的仓库后再导入。",
    );
  }

  const hit = located[0];
  const buildState = mapCrpBuildState(release.buildState);

  return {
    plan: {
      packageName,
      packageId: registered?.id ?? null,
      repoPath: hit.repoPath,
      branch: release.branch,
      commitSha: hit.commitSha,
      commitSource: hit.commitSource,
      codeVersion: hit.codeVersion,
      repoVersion,
      // MUST：提测版本逐字取自 CRP Release 的 tag，不做任何清洗。
      releaseVersion: release.tag,
      crpReleaseId: String(release.releaseId),
      crpBuildId: release.buildId > 0 ? String(release.buildId) : null,
      buildState: release.buildState,
      buildStateKnown: buildState.known,
      buildStateNote: buildState.note,
      status: buildState.status,
      versionMismatch: release.tag !== hit.codeVersion,
    },
  };
}

/**
 * 算出这次导入要做什么，不写任何数据。
 *
 * 页面按它显示逐包映射与卡住的包；真正导入时再按同样的输入算一遍 ——
 * 两份结论来自同一个函数，页面看到的就是服务端要做的。
 */
async function buildImportPlan(
  options: ReleaseImportOptions,
): Promise<ImportPlan> {
  const project = await loadUsableProject(options.projectId);
  const crp = resolveCrp(options.network);
  const reader = options.reader ?? createGerritReader();
  const { topic, branchName } = await assertTopicImportable(crp, project, options.topicId);

  const releases = await callCrp("读主题里的 Release", () => crp.listReleases(topic.id));

  if (releases.length === 0) {
    throw new ReleaseError(`主题「${topic.name}」里没有任何 Release，没有可导入的内容。`, 409);
  }

  const existing = await findExistingImport(topic.id);
  // 先去重，再映射：同一个 CRP 项目名在主题里出现多次时，映射与候选只需要算一次。
  const crpProjectNames = [...new Set(releases.map((item) => item.projectName.trim()))].filter(
    (name) => name !== "",
  );
  const mapping = await mapCrpProjectNames(crpProjectNames);
  const { registered, candidates } = await loadRepoCandidates(crpProjectNames, mapping, reader);

  // 基线里的仓库版本按「本地包名」查：`baseline_package_version.package_name` 是 Debian 源码包名，
  // 与 CRP 项目名无关，拿 CRP 项目名去查一个也查不到。
  const localNames = [...new Set(crpProjectNames.map((name) => localPackageNameOf(name, mapping)))];

  const versions = await prisma.baselinePackageVersion.findMany({
    where: { baselineId: project.baseline.id, packageName: { in: localNames } },
    select: { packageName: true, version: true },
  });
  const repoVersionByName = new Map(versions.map((row) => [row.packageName, row.version]));

  const packages: ImportedPackagePlan[] = [];
  const blocked: ImportedBlockedPackage[] = [];
  const plannedNames = new Set<string>();

  for (const release of releases) {
    const crpProjectName = release.projectName.trim();
    const packageName = localPackageNameOf(crpProjectName, mapping);

    // 同一个 CRP 项目在主题里出现两次（不同分支各一条），或两个 CRP 项目落到同一个本地包上时，
    // 本地一条提测里只能有一轮，硬塞会撞上 `(releaseId, packageName, attempt)` 唯一约束，所以当场停手。
    if (plannedNames.has(packageName)) {
      blocked.push({
        packageName,
        reason:
          "主题里同一个软件包有多条 Release（分支或 CRP 项目不同），" +
          "本平台的提测里一个包只能有一轮，请先在 CRP 清理。",
      });
      continue;
    }

    const ambiguousHits = mapping.ambiguous.get(crpProjectName);

    // 映射歧义：这个 CRP 项目名同时对上了不止一个本地软件包，挑一个用会把提测挂到错误的包上。
    if (ambiguousHits !== undefined) {
      blocked.push({
        packageName: packageName === "" ? `Release ${release.releaseId}` : packageName,
        reason:
          `CRP 项目名「${crpProjectName}」映射歧义：同时对上了本地软件包 ${ambiguousHits.join("、")}。` +
          "请在软件包管理里核对「CRP 项目名」这一列，只留一个包填它。",
      });
      continue;
    }

    const outcome = await planPackage(
      {
        release,
        packageName,
        registered: registered.get(crpProjectName),
        candidates: candidates.get(crpProjectName) ?? [],
        repoVersion: repoVersionByName.get(packageName) ?? null,
      },
      reader,
    );

    if ("blocked" in outcome) {
      blocked.push(outcome.blocked);
      continue;
    }

    plannedNames.add(packageName);
    packages.push(outcome.plan);
  }

  return { project, topic, branchName, packages, blocked, existing };
}

/**
 * 导入预览：逐包展示 CRP 的映射结果，卡住的包点名。
 *
 * 不写库、不写 CRP，可以反复调用。
 */
export async function previewReleaseImport(
  options: ReleaseImportOptions,
): Promise<ReleaseImportPreview> {
  const plan = await buildImportPlan(options);

  return {
    project: {
      id: plan.project.id,
      key: plan.project.key,
      name: plan.project.name,
      baselineId: plan.project.baseline.id,
      baselineName: plan.project.baseline.name,
    },
    topic: {
      id: plan.topic.id,
      name: plan.topic.name,
      branchId: plan.topic.branchId,
      branchName: plan.branchName,
      owner: plan.topic.owner,
      type: plan.topic.type,
      abandoned: plan.topic.abandoned,
      completed: plan.topic.completed,
    },
    packages: plan.packages,
    blocked: plan.blocked,
    existing: plan.existing,
    ready: plan.blocked.length === 0 && plan.existing === null,
  };
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** 导入后现读一次 CRP 工作流进度：不落这一步，记录无法判断「还能不能改包」。 */
async function readWorkProgress(
  crp: ImportCrpApis,
  topicId: number,
): Promise<
  | { workProgress: number; workProgressLabel: string; workProgressError: null }
  | { workProgress: null; workProgressLabel: null; workProgressError: string }
> {
  try {
    const workflow = await crp.getTopicWorkflow(topicId);

    return {
      workProgress: workflow.workProgress,
      workProgressLabel: workflow.workProgressLabel,
      workProgressError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 提测已经落库，读不到进度不算导入失败：如实报告，下次轮询还会补上。
    console.error(`[releases] 导入后读 CRP 工作流进度失败（topic ${topicId}）`, error);

    return { workProgress: null, workProgressLabel: null, workProgressError: message };
  }
}

/**
 * 把一个 CRP 主题导入成提测记录。
 *
 * 顺序固定：先算计划（与预览同一份），卡住的包一个都不许放过 —— 停手并点名；
 * 已导入过的主题提示并给出已有记录，不新建；然后是「软件包记录 → 提测 → 快照 → CRP 关联」
 * 一个事务，最后读一次 CRP 工作流进度。
 *
 * 整个过程不向 CRP 写任何东西。
 */
export async function importReleaseFromTopic(
  options: ImportReleaseFromTopicOptions,
): Promise<ImportedRelease> {
  const plan = await buildImportPlan(options);

  if (plan.blocked.length > 0) {
    const detail = plan.blocked
      .map((item) => `${item.packageName}：${item.reason}`)
      .join("；");

    throw new ReleaseError(`导入停在预览步骤，这些包还不能导入：${detail}`, 409);
  }

  if (plan.existing !== null) {
    throw new ReleaseImportConflict(
      `这个主题已经导入到项目「${plan.existing.projectName}」（提测版本 ${plan.existing.version}），` +
        "同一个主题只能导入一次。",
      { releaseId: plan.existing.releaseId, version: plan.existing.version },
    );
  }

  const status = releaseStatusFromSnapshots(plan.packages.map((item) => item.status));
  // 提测版本取第一条 Release 的 tag：主题本身没有版本号，CRP 侧的版本挂在每个 Release 上。
  const version = plan.packages[0].releaseVersion;
  const now = new Date();
  const softwarePackageIds = new Map(
    plan.project.packages.map((item) => [item.packageName, item.packageId]),
  );
  const autoRegisteredPackages = plan.packages
    .filter((item) => item.packageId === null)
    .map((item) => item.packageName);
  const addedToProject: string[] = [];

  let releaseId: string;

  try {
    releaseId = await prisma.$transaction(async (tx) => {
      // 1. 未登记的软件包先建记录：名称取包名、仓库路径取 Gerrit 反查到的那个、默认分支取 release 的分支。
      const packageIdByName = new Map(softwarePackageIds);

      for (const item of plan.packages) {
        if (item.packageId !== null) {
          continue;
        }

        const created = await tx.package.create({
          data: {
            name: item.packageName,
            repoPath: item.repoPath,
            defaultBranch: item.branch,
          },
          select: { id: true },
        });

        packageIdByName.set(item.packageName, created.id);
      }

      // 2. 提测记录本身。
      const release = await tx.release.create({
        data: {
          projectId: plan.project.id,
          version,
          revision: 1,
          status,
          source: "imported",
          description: `从 CRP 主题 ${plan.topic.id}「${plan.topic.name}」导入`,
          createdById: options.createdById,
          crpTopicId: String(plan.topic.id),
          crpBranchId: String(plan.topic.branchId),
          crpTopicState: plan.topic.state,
          crpTopicAbandoned: plan.topic.abandoned,
          crpTopicCompleted: plan.topic.completed,
        },
        select: { id: true },
      });

      // 3. 每个包一轮快照，状态直接取 CRP 的构建状态；同时记下对应的 CRP Release。
      for (const item of plan.packages) {
        const snapshot = await tx.releasePackageSnapshot.create({
          data: {
            releaseId: release.id,
            packageName: item.packageName,
            attempt: 1,
            branch: item.branch,
            commitSha: item.commitSha,
            codeVersion: item.codeVersion,
            repoVersion: item.repoVersion,
            releaseVersion: item.releaseVersion,
            status: item.status,
            statusChangedAt: now,
          },
          select: { id: true },
        });

        await tx.releaseRepositoryRecord.create({
          data: {
            releaseId: release.id,
            snapshotId: snapshot.id,
            crpReleaseId: item.crpReleaseId,
            crpBuildId: item.crpBuildId,
            lastSyncedAt: now,
          },
        });

        const packageId = packageIdByName.get(item.packageName);

        if (packageId === undefined) {
          continue;
        }

        // 4. 清单里已有的包回写「上次提测的提交」，与 A11 创建提测同一口径。
        await tx.projectSoftware.updateMany({
          where: { projectId: plan.project.id, packageId },
          data: { lastSubmittedCommit: item.commitSha, lastSubmittedAt: now },
        });

        // 5. 只有明确勾选时才动项目软件清单（默认不勾）。
        if (options.addPackagesToProject === true && !softwarePackageIds.has(item.packageName)) {
          await tx.projectSoftware.create({
            data: {
              projectId: plan.project.id,
              packageId,
              trackedBranch: item.branch,
              lastSubmittedCommit: item.commitSha,
              lastSubmittedAt: now,
            },
          });
          addedToProject.push(item.packageName);
        }
      }

      return release.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReleaseError(
        `这个项目已经有版本号「${version}」的提测记录，或者某个软件包的仓库路径已被别的包占用，` +
          "请先在软件包管理核对后再导入。",
        409,
      );
    }

    throw error;
  }

  // 6. 导入后立刻落一次 CRP 工作流进度：已转测（>= 20）的记录 A17 不再允许改包。
  const progress = await readWorkProgress(resolveCrp(options.network), plan.topic.id);

  if (progress.workProgress !== null) {
    await prisma.release.update({
      where: { id: releaseId },
      data: {
        crpWorkProgress: progress.workProgress,
        crpWorkProgressLabel: progress.workProgressLabel,
        crpWorkProgressSyncedAt: new Date(),
      },
    });
  }

  return {
    releaseId,
    version,
    revision: 1,
    status,
    packages: plan.packages,
    autoRegisteredPackages,
    addedToProject,
    workProgress: progress.workProgress,
    workProgressLabel: progress.workProgressLabel,
    workProgressError: progress.workProgressError,
    locked:
      progress.workProgress !== null && progress.workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST,
  };
}
