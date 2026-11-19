/**
 * 提测增量更新（A17）：补包、换包，以及换包之后依赖链的自动作废重投。
 *
 * 一条提测创建之后不是定终身的。只要 CRP 那边还没转测，就还能往里面补包、换包；
 * 上游一换，基于旧上游构建出来的下游包必须一起作废，不能留在仓库里。
 *
 * 三条判定都在服务端做，页面上的禁用只算提示：
 *
 * 1. **能不能改**看 CRP 现读的工作流进度（`GET /topics/{id}/workflow/info`）。
 *    `Release.crpWorkProgress` 是上一次轮询写下的旧值，可能已经过期，不能拿它当准。
 *    读不到进度（连不上、认证失败）一律拒绝，不默认放行。
 * 2. **改谁**由依赖图算：换掉的包加上它的全部传递下游，多层；清单外的包不参与。
 * 3. **怎么重投**交给 A12 的 `advanceRelease`：这里只把该作废的作废、该新起一轮的新起一轮，
 *    投递顺序、上游失败阻断下游这些规则仍然只有一份。
 *
 * 串行化用数据库行锁：更新在一个事务里先 `SELECT … FOR UPDATE` 锁住这条提测，
 * 第二个并发的更新要么排队、要么在锁等待超时后收到明确拒绝，绝不会两条更新同时改一条提测。
 *
 * 放弃 CRP Release 也在同一个事务里做。数据库能整体回滚，CRP 侧的删除不能，所以这里有两层保障：
 *
 * 1. 任何一条删不掉就当场抛错，数据库那一半整体回滚；
 * 2. 已经删成功的那几条由 `compensateAbandoned()` 在独立事务里补偿：把对应包的当前轮快照
 *    退回 `pending`，提测回到 `dispatching`，让定时器按原参数把它们重新投出去。
 *    不补偿的话，提测会显示「成功」而 CRP 侧少了包，正是「不留半成品」要排除的状态。
 */

import { Prisma } from "../../generated/prisma/client";
import { getBaselineVersion } from "../baselines";
import {
  advanceRelease,
  createCrpCallRecorder,
  loadReleaseDispatch,
  type AdvanceResult,
  type BuildNetwork,
  type DispatchPackageView,
} from "../build";
import { prisma } from "../db";
import { GerritError } from "../integrations/gerrit";
import {
  createCrpClient,
  createCrpClientFromEnv,
  CRP_DEFAULT_BASE_URL,
  CrpError,
  WORK_PROGRESS,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  workProgressLabel,
  type CrpClient,
} from "../integrations/crp";
import {
  formatCycle,
  sortByDependencies,
  type DependencyEdge,
} from "../packages/dependencyGraph";
import { collectDownstream } from "./downstream";
import { createGerritReader, type GerritReader } from "./gerrit";
import { loadReleaseProject, ReleaseError } from "./service";
import type { ReleaseUpdateInput } from "./validation";

/** 锁等待上限：第二个并发更新等这么久还拿不到锁，就明确拒绝，不无限期挂着。 */
const LOCK_WAIT_LIMIT = "3000ms";

/**
 * 一次 CRP 调用的最坏耗时。
 *
 * 默认单次超时 30 秒、最多 4 次尝试（首次 + 3 次重试），退避 300 / 600 / 1200 毫秒，
 * 合计约 122 秒。事务上限按「要放弃几条」乘以这个值算，不能用固定的 180 秒：
 * 两条最坏的删除就能把它撑爆，事务在删完之前超时回滚。
 */
const WORST_CASE_CRP_CALL_MS = 130_000;

/**
 * 事务里的固定开销：现读一次 CRP 工作流、若干次写库。
 *
 * 工作流那次也是 CRP 调用，所以同样按最坏耗时算。
 */
const TRANSACTION_BASE_TIMEOUT_MS = WORST_CASE_CRP_CALL_MS + 30_000;

/** 事务里除了写库，还要先等一条空闲连接。 */
const TRANSACTION_MAX_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export type ReleaseUpdateOptions = {
  /** 发起人，取自会话。 */
  operatorId: string;
  /** 读代码版本用；单测注入假实现，生产代码不传，按环境变量建 Gerrit 客户端。 */
  reader?: Pick<GerritReader, "readCodeVersion">;
  /** 注入用的网络接线，与 A12 的 `BuildOptions.network` 同一形状。 */
  network?: BuildNetwork;
};

/** 预览只需要网络接线，不需要发起人。 */
export type ReleaseUpdatePreviewOptions = Pick<ReleaseUpdateOptions, "reader" | "network">;

/** 来不及改的原因也只需要网络接线。 */
export type ReleaseUpdateViewOptions = Pick<ReleaseUpdateOptions, "network">;

/** 新起的一轮快照。字段与 `release_package_snapshot` 的列一一对应。 */
export type PlannedSnapshot = {
  packageName: string;
  attempt: number;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
};

/** 为什么要新起这一轮。 */
export type PlannedRoundReason = "append" | "replace" | "downstream";

/** 一次更新要新起的一轮快照。 */
export type PlannedRound = {
  packageName: string;
  reason: PlannedRoundReason;
  snapshot: PlannedSnapshot;
  /** 被这一轮替换掉的旧快照；补包的包没有旧轮，为 `null`。 */
  supersedesSnapshotId: string | null;
};

/** 一个要在 CRP 侧放弃的 Release。 */
export type AbandonedCrpRelease = {
  packageName: string;
  crpReleaseId: string;
};

/** 一次更新要做的事，页面确认与真正执行读的是同一份。 */
export type ReleaseUpdatePlan = {
  releaseId: string;
  version: string;
  /** 更新前后的提测轮次。 */
  revisionBefore: number;
  revisionAfter: number;
  /** 更新时现读到的 CRP 工作流进度。 */
  workProgress: number;
  workProgressLabel: string;
  /** 要新起的轮次，按投递顺序（上游在前）。 */
  rounds: PlannedRound[];
  /** 要在 CRP 侧放弃的 Release。 */
  abandoned: AbandonedCrpRelease[];
  /** 更新之后的投递顺序（上游在前）。 */
  order: string[];
  /** 这次追加的软件包。 */
  appendedPackageNames: string[];
  /** 这次换版本的软件包。 */
  replacedPackageNames: string[];
  /**
   * 这次要重新投递的软件包：补包是新加的那些，换包是被换的包加上它的全部传递下游。
   *
   * 与 `rounds` 不完全一致：还没投递过的下游没有旧产物要作废，不新起轮次，
   * 但它确实会跟着新上游一起构建，所以算在重投名单里。
   */
  redispatchedPackageNames: string[];
};

/** 一次更新的结果。 */
export type ReleaseUpdateResult = {
  releaseId: string;
  revision: number;
  plan: ReleaseUpdatePlan;
  /** 实际在 CRP 侧放弃掉的 Release ID。 */
  abandonedCrpReleaseIds: string[];
  /** 更新之后立刻推进一次的结果；推进失败为 `null`，原因见 `advanceError`。 */
  advance: AdvanceResult | null;
  /**
   * 推进失败的原因。
   *
   * 更新本身已经提交，投递没开始不算更新失败：提测状态已经回到「投递中」，
   * 外部定时器会继续推进它，所以这里只如实报告，不把整次更新判成失败。
   */
  advanceError: string | null;
};

/** 一条更新留痕，页面直接列出。 */
export type ReleaseUpdateHistoryRow = {
  id: string;
  action: "append" | "replace";
  packageNames: string[];
  revisionBefore: number;
  revisionAfter: number;
  abandonedCrpReleaseIds: string[];
  redispatchedPackageNames: string[];
  createdAt: Date;
  operatorName: string;
};

/** 还能补进来的软件包。 */
export type ReleaseUpdateCandidate = {
  packageName: string;
  repoPath: string;
  trackedBranch: string;
};

/** 更新页要显示的全部内容。 */
export type ReleaseUpdateView = {
  releaseId: string;
  version: string;
  revision: number;
  status: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  crpTopicId: string | null;
  /** 现读到的 CRP 工作流进度；读不到为 `null`。 */
  workProgress: number | null;
  workProgressLabel: string | null;
  /** 读不到进度的原因。 */
  workProgressError: string | null;
  /** 现在不能改的原因；能改时为 `null`。 */
  lockReason: string | null;
  packages: DispatchPackageView[];
  candidates: ReleaseUpdateCandidate[];
  history: ReleaseUpdateHistoryRow[];
};

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

const CURRENT_SNAPSHOT_SELECT = {
  id: true,
  packageName: true,
  attempt: true,
  branch: true,
  commitSha: true,
  codeVersion: true,
  repoVersion: true,
  releaseVersion: true,
  status: true,
  repositoryRecord: { select: { crpReleaseId: true } },
} as const;

/** 一条提测加上它当前轮的快照（被替换的旧轮不参与判定）。 */
async function loadReleaseForUpdate(releaseId: string) {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      projectId: true,
      version: true,
      revision: true,
      status: true,
      crpTopicId: true,
      snapshots: {
        where: { supersededById: null },
        orderBy: [{ packageName: "asc" }, { attempt: "desc" }],
        select: CURRENT_SNAPSHOT_SELECT,
      },
    },
  });

  if (release === null) {
    throw new ReleaseError("提测记录不存在。", 404);
  }

  return release;
}

type LoadedReleaseForUpdate = Awaited<ReturnType<typeof loadReleaseForUpdate>>;
type CurrentSnapshot = LoadedReleaseForUpdate["snapshots"][number];

/** 更新要用的那几个 CRP 能力。 */
type UpdateCrpApis = Pick<CrpClient, "getTopicWorkflow" | "deleteRelease">;

/**
 * 建 CRP 客户端，并把调用记录挂到请求层上。
 *
 * 放弃 Release、现读工作流这两件事都会发请求，它们要能在 `crp_call_log` 里查到（AC1、AC5 的证据）。
 */
function resolveCrp(releaseId: string, network: BuildNetwork | undefined): UpdateCrpApis {
  const recorder = createCrpCallRecorder(releaseId);

  if (network?.crpFetch === undefined) {
    return createCrpClientFromEnv(process.env, { onRequest: recorder.observe });
  }

  return createCrpClient({
    baseUrl: network.crpBaseUrl ?? CRP_DEFAULT_BASE_URL,
    token: network.crpToken ?? "injected",
    tokenPath: null,
    fetchImpl: network.crpFetch,
    onRequest: recorder.observe,
  });
}

/**
 * 现读 CRP 的工作流进度。
 *
 * MUST：判断能不能改以服务端现读到的 `WorkProgress` 为准，不认库里的旧值。
 * 读不到就抛错（网络错误与认证失败都算「读不到」），由调用方拒绝这次更新。
 * 还没建 Topic 的提测没有任何 CRP 内容可锁，按「未开始」处理。
 */
async function readWorkProgress(
  crp: UpdateCrpApis,
  topicId: string | null,
): Promise<{ workProgress: number; label: string }> {
  if (topicId === null) {
    return { workProgress: WORK_PROGRESS.notStarted, label: workProgressLabel(WORK_PROGRESS.notStarted) };
  }

  try {
    const workflow = await crp.getTopicWorkflow(Number(topicId));
    return { workProgress: workflow.workProgress, label: workflow.workProgressLabel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[releases] 读 CRP 工作流进度失败（topic ${topicId}）`, error);
    throw new ReleaseError(
      `读不到 CRP 的工作流进度（${message}），无法判断这条提测是否已经转测，这次更新已取消。`,
      502,
    );
  }
}

/** MUST NOT：已转测（`WorkProgress >= 20`）时不做任何改动，也不往这个 Topic 投任何 Release。 */
function assertNotTransferredToTest(workProgress: number, label: string): void {
  if (workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST) {
    throw new ReleaseError(
      `这条提测已经转测（CRP 工作流进度 ${workProgress}：${label}），转测之后不能再补包或换包。`,
      409,
    );
  }
}

/** 本提测内各包的依赖边。清单外的上游不参与：那些包不在这条提测里，构不成先后关系。 */
async function loadDependencyEdges(packageNames: readonly string[]): Promise<DependencyEdge[]> {
  if (packageNames.length === 0) {
    return [];
  }

  const rows = await prisma.package.findMany({
    where: { name: { in: [...packageNames] } },
    select: {
      name: true,
      dependencies: { select: { upstreamPackage: { select: { name: true } } } },
    },
  });

  return rows.flatMap((row) =>
    row.dependencies.map((edge) => ({ from: row.name, to: edge.upstreamPackage.name })),
  );
}

/** 读代码版本并把各种失败翻成能显示的话。 */
async function readCodeVersion(
  reader: Pick<GerritReader, "readCodeVersion">,
  repoPath: string,
  commitSha: string,
  packageName: string,
): Promise<string> {
  try {
    return await reader.readCodeVersion(repoPath, commitSha);
  } catch (error) {
    if (error instanceof ReleaseError) {
      throw error;
    }

    if (error instanceof GerritError) {
      throw new ReleaseError(`读取「${packageName}」的代码版本失败：${error.message}`, 502);
    }

    console.error(`[releases] 读取 ${packageName} 的代码版本失败`, error);
    throw new ReleaseError(`读取「${packageName}」的代码版本失败，请稍后重试。`, 502);
  }
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

type PlanContext = {
  plan: ReleaseUpdatePlan;
  projectId: string;
  /** 包名 → 项目清单行 ID，回写「上次提测的提交」时用。 */
  packageIds: Map<string, string>;
};

/**
 * 算出这次更新要做的事，不改任何数据。
 *
 * 页面按它显示「将放弃 N 个、重投 N 个」，真正执行时再按同样的输入算一遍 ——
 * 两份结论来自同一个函数，页面看到的就是服务端要做的。
 */
async function buildUpdatePlan(
  releaseId: string,
  input: ReleaseUpdateInput,
  options: ReleaseUpdatePreviewOptions,
  crp: UpdateCrpApis,
): Promise<PlanContext> {
  const release = await loadReleaseForUpdate(releaseId);

  if (release.status === "abandoned") {
    throw new ReleaseError("这条提测已经取消，不能再补包或换包。", 409);
  }

  const project = await loadReleaseProject(release.projectId);

  if (project === null) {
    throw new ReleaseError("提测所属的项目不存在，无法更新软件包。", 409);
  }

  if (project.deletedAt !== null) {
    throw new ReleaseError("提测所属的项目已删除，不能再更新软件包。", 409);
  }

  const packageByName = new Map(project.packages.map((item) => [item.packageName, item]));
  const currentByName = new Map<string, CurrentSnapshot>();

  for (const snapshot of release.snapshots) {
    // 同一个包只认最高轮次：正常数据里只有一行。
    if (!currentByName.has(snapshot.packageName)) {
      currentByName.set(snapshot.packageName, snapshot);
    }
  }

  for (const item of input.append) {
    if (!packageByName.has(item.packageName)) {
      throw new ReleaseError(
        `「${item.packageName}」不在项目软件清单里，不能追加。先到项目详情页把它加进清单。`,
        409,
      );
    }

    if (currentByName.has(item.packageName)) {
      throw new ReleaseError(
        `「${item.packageName}」已经在这条提测里，要改它的分支或 Commit 请用换包。`,
        409,
      );
    }
  }

  for (const item of input.replace) {
    if (!currentByName.has(item.packageName)) {
      throw new ReleaseError(
        `「${item.packageName}」不在这条提测里，要加它请用补包。`,
        409,
      );
    }
  }

  const { workProgress, label } = await readWorkProgress(crp, release.crpTopicId);

  assertNotTransferredToTest(workProgress, label);

  const reader = options.reader ?? createGerritReader();
  const inside = new Set<string>([
    ...currentByName.keys(),
    ...input.append.map((item) => item.packageName),
  ]);
  const edges = await loadDependencyEdges([...inside]);
  const rounds: PlannedRound[] = [];
  const abandoned: AbandonedCrpRelease[] = [];

  // 补包：新起第 1 轮。提测版本取自定义 Tag，没填就是代码版本 —— 与建提测的规则一致。
  for (const item of input.append) {
    const pkg = packageByName.get(item.packageName);

    if (pkg === undefined) {
      continue;
    }

    const codeVersion = await readCodeVersion(reader, pkg.repoPath, item.commitSha, item.packageName);

    rounds.push({
      packageName: item.packageName,
      reason: "append",
      supersedesSnapshotId: null,
      snapshot: {
        packageName: item.packageName,
        attempt: 1,
        branch: item.branch,
        commitSha: item.commitSha,
        codeVersion,
        repoVersion: await getBaselineVersion(project.baseline.id, item.packageName),
        releaseVersion: item.customTag ?? codeVersion,
      },
    });
  }

  // 换包：新起一轮（`attempt + 1`），旧轮保留下来标 `superseded`。
  for (const item of input.replace) {
    const current = currentByName.get(item.packageName) as CurrentSnapshot;

    assertNotDispatching(item.packageName, current);

    const pkg = packageByName.get(item.packageName);

    if (pkg === undefined) {
      throw new ReleaseError(`「${item.packageName}」不在项目软件清单里，读不到仓库地址。`, 409);
    }

    const codeVersion = await readCodeVersion(reader, pkg.repoPath, item.commitSha, item.packageName);

    rounds.push({
      packageName: item.packageName,
      reason: "replace",
      supersedesSnapshotId: current.id,
      snapshot: {
        packageName: item.packageName,
        attempt: current.attempt + 1,
        branch: item.branch,
        commitSha: item.commitSha,
        codeVersion,
        repoVersion: await getBaselineVersion(project.baseline.id, item.packageName),
        // MUST：重投沿用同一个提测版本号（Tag 不变），只换 Commit 与代码版本。
        // 只有明确给了新 Tag 才改，这是「修改提测版本」那条入口。
        releaseVersion: item.customTag ?? current.releaseVersion,
      },
    });

    if (current.repositoryRecord !== null) {
      abandoned.push({
        packageName: item.packageName,
        crpReleaseId: current.repositoryRecord.crpReleaseId,
      });
    }
  }

  // 传递下游：换了上游之后，所有依赖它的包都要作废重投，多层都算。
  const replacedNames = input.replace.map((item) => item.packageName);
  const appendedNames = input.append.map((item) => item.packageName);
  const downstream = collectDownstream(replacedNames, edges, inside).filter(
    // 这次新补的包还没有旧产物，由它自己的第 1 轮负责，不在这里另起一轮。
    (name) => !appendedNames.includes(name),
  );

  for (const name of downstream) {
    const current = currentByName.get(name);

    if (current === undefined) {
      continue;
    }

    assertNotDispatching(name, current);

    if (current.repositoryRecord === null) {
      // 还没投递过：没有旧产物要作废，让它按新上游的顺序正常投出去就行。
      continue;
    }

    rounds.push({
      packageName: name,
      reason: "downstream",
      supersedesSnapshotId: current.id,
      snapshot: {
        packageName: name,
        attempt: current.attempt + 1,
        // 下游自己的参数一概不变，只是把「基于旧上游」的产物换成基于新上游重建的。
        branch: current.branch,
        commitSha: current.commitSha,
        codeVersion: current.codeVersion,
        repoVersion: current.repoVersion,
        releaseVersion: current.releaseVersion,
      },
    });

    abandoned.push({
      packageName: name,
      crpReleaseId: current.repositoryRecord.crpReleaseId,
    });
  }

  const sorted = sortByDependencies([...inside], edges);

  if (sorted.cycle !== null) {
    throw new ReleaseError(
      `软件依赖存在环：${formatCycle(sorted.cycle)}，排不出投递顺序，无法更新。`,
      409,
    );
  }

  const rank = new Map(sorted.order.map((name, index) => [name, index]));
  rounds.sort((left, right) => (rank.get(left.packageName) ?? 0) - (rank.get(right.packageName) ?? 0));

  return {
    projectId: release.projectId,
    packageIds: new Map(project.packages.map((item) => [item.packageName, item.packageId])),
    plan: {
      releaseId: release.id,
      version: release.version,
      revisionBefore: release.revision,
      revisionAfter: release.revision + 1,
      workProgress,
      workProgressLabel: label,
      rounds,
      abandoned,
      order: sorted.order,
      appendedPackageNames: appendedNames,
      replacedPackageNames: replacedNames,
      redispatchedPackageNames:
        replacedNames.length === 0 ? [] : [...new Set([...replacedNames, ...downstream])].sort(),
    },
  };
}

/**
 * 正在投递的包不能换。
 *
 * 「投递中」表示 CRP 请求已经发出、本地记录还没写完；这时候替换它，会在 CRP 侧留下一条
 * 谁也不知道的 Release。等这一轮投递结束（几秒）再改。
 */
function assertNotDispatching(packageName: string, current: CurrentSnapshot): void {
  if (current.status === "dispatching") {
    throw new ReleaseError(
      `「${packageName}」正在投递，等这一轮投递结束再更新。`,
      409,
    );
  }
}

/** 预览：只算不改，页面拿它显示「将放弃 N 个、重投 N 个」。 */
export async function previewReleaseUpdate(
  releaseId: string,
  input: ReleaseUpdateInput,
  options: ReleaseUpdatePreviewOptions = {},
): Promise<ReleaseUpdatePlan> {
  const crp = resolveCrp(releaseId, options.network);
  const { plan } = await buildUpdatePlan(releaseId, input, options, crp);

  return plan;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 行锁：事务里锁住这条提测，别的更新请求改不动它。
 *
 * 锁等待有上限（3 秒），等不到就明确拒绝，不让调用方无休止地挂着。
 */
async function lockRelease(tx: Prisma.TransactionClient, releaseId: string): Promise<void> {
  // `SET LOCAL` 不接受绑定参数（PostgreSQL 的 SET 里不能写 `$1`），只能拼字符串；
  // 拼进去的是上面那个常量，没有外部输入，不存在注入面。
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_LIMIT}'`);

  try {
    await tx.$queryRaw`SELECT "id" FROM "release" WHERE "id" = ${releaseId} FOR UPDATE`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/lock timeout|could not obtain lock/i.test(message)) {
      throw new ReleaseError("另一个更新正在进行，请等它结束后再试。", 409);
    }

    throw error;
  }
}

/** CRP 侧已经没有这条 Release 时，放弃的目标本来就达到了。 */
function isAlreadyDeleted(error: unknown): boolean {
  return error instanceof CrpError && error.status === 404;
}

/**
 * 放弃下游：逐个删掉旧的 CRP Release。
 *
 * 删除失败立即抛错中止整次更新（MUST NOT 跳过失败继续投）。已经删成功的那几条写进
 * `deletedCrpReleaseIds`，由调用方补偿 —— CRP 侧的删除不会跟着数据库事务回滚。
 * CRP 已经删掉的（回 404）当成功：那一刻想要的结果已经达成，重试也不该卡在这里。
 */
async function abandonDownstream(
  crp: UpdateCrpApis,
  abandoned: readonly AbandonedCrpRelease[],
  deletedCrpReleaseIds: string[],
): Promise<void> {
  for (const item of abandoned) {
    try {
      await crp.deleteRelease(Number(item.crpReleaseId));
    } catch (error) {
      if (!isAlreadyDeleted(error)) {
        const message = error instanceof Error ? error.message : String(error);

        console.error(
          `[releases] 放弃「${item.packageName}」的 CRP Release ${item.crpReleaseId} 失败`,
          error,
        );
        throw new ReleaseError(
          `放弃「${item.packageName}」的旧 Release（${item.crpReleaseId}）失败：${message}。` +
            "这次更新已中止，提测保持原样。",
          502,
        );
      }
    }

    deletedCrpReleaseIds.push(item.crpReleaseId);
  }
}

/**
 * 放弃中途失败之后的补偿。
 *
 * 数据库那半边会整体回滚，但 CRP 侧删掉的 Release 回不来：那些包的本地快照仍写着「成功」、
 * 还挂着一条已经不存在的 `crpReleaseId`，而 `pollReleaseBuilds` 对 CRP 侧查不到的 Release
 * 是「不动本地状态」，没有自动修复的路径。不补偿的话，提测会显示成功而 CRP 少一个包。
 *
 * 做法是把受影响的包退回可重投状态：
 *
 * - 当前轮快照置 `pending`（历史轮次不动）—— 定时器会挑中它，按同一份快照参数重投；
 * - 提测状态回到 `dispatching`、清掉 `finishedAt` —— 否则终局状态会被 `advanceRelease`
 *   直接跳过，退回的包永远没人投。
 *
 * 重投沿用原快照的分支、Commit 与 Tag，所以补回来的产物与作废前完全一致。
 *
 * **必须在事务失败退出之后调用**：这个函数要改提测那一行，而失败的事务在回滚之前一直握着
 * 它的行锁，放在事务里调用会和自己的锁死等。
 */
async function compensateAbandoned(
  releaseId: string,
  deletedCrpReleaseIds: readonly string[],
): Promise<void> {
  if (deletedCrpReleaseIds.length === 0) {
    return;
  }

  const records = await prisma.releaseRepositoryRecord.findMany({
    where: { releaseId, crpReleaseId: { in: [...deletedCrpReleaseIds] } },
    select: { snapshot: { select: { id: true, packageName: true } } },
  });

  if (records.length === 0) {
    return;
  }

  const now = new Date();

  console.warn(
    `[releases] 提测 ${releaseId} 的更新中止，但 CRP 侧已删掉 ${records.length} 条 Release，` +
      `把这些包退回待投递：${records.map((item) => item.snapshot.packageName).join("、")}`,
  );

  await prisma.$transaction(async (tx) => {
    for (const record of records) {
      // 只退当前轮：万一这一行已经被替换，历史轮次不能被改回「待投递」。
      await tx.releasePackageSnapshot.updateMany({
        where: { id: record.snapshot.id, supersededById: null },
        data: { status: "pending", statusChangedAt: now },
      });
    }

    await tx.release.update({
      where: { id: releaseId },
      data: { status: "dispatching", finishedAt: null },
    });
  });
}

/** 一条计划里的轮次要写成的快照行。 */
type CreatedRound = { round: PlannedRound; snapshotId: string };

/**
 * 写新轮。
 *
 * 必须先写新轮：旧轮的 `superseded_by_id` 指向它，外键要求它已经存在。
 */
async function createRounds(
  tx: Prisma.TransactionClient,
  releaseId: string,
  plan: ReleaseUpdatePlan,
): Promise<CreatedRound[]> {
  const created: CreatedRound[] = [];

  for (const round of plan.rounds) {
    const row = await tx.releasePackageSnapshot.create({
      data: {
        releaseId,
        packageName: round.snapshot.packageName,
        attempt: round.snapshot.attempt,
        branch: round.snapshot.branch,
        commitSha: round.snapshot.commitSha,
        codeVersion: round.snapshot.codeVersion,
        repoVersion: round.snapshot.repoVersion,
        releaseVersion: round.snapshot.releaseVersion,
      },
      select: { id: true },
    });

    created.push({ round, snapshotId: row.id });
  }

  return created;
}

/**
 * 旧轮标 `superseded` 并指向新轮，不物理删除（MUST）。
 *
 * 条件更新再挡一次并发投递：这一行要是刚好被抢占成「投递中」，整体回滚并让人稍后重试。
 */
async function supersedeOldRounds(
  tx: Prisma.TransactionClient,
  created: readonly CreatedRound[],
  now: Date,
): Promise<void> {
  for (const { round, snapshotId } of created) {
    if (round.supersedesSnapshotId === null) {
      continue;
    }

    const updated = await tx.releasePackageSnapshot.updateMany({
      where: {
        id: round.supersedesSnapshotId,
        supersededById: null,
        status: { not: "dispatching" },
      },
      data: { supersededById: snapshotId, supersededAt: now, status: "superseded" },
    });

    if (updated.count === 0) {
      throw new ReleaseError(
        `「${round.packageName}」的旧快照正在变化，这次更新已中止，请稍后重试。`,
        409,
      );
    }
  }
}

/** 把这次更新落到提测记录与留痕表上。 */
async function writeUpdateRecords(
  tx: Prisma.TransactionClient,
  releaseId: string,
  plan: ReleaseUpdatePlan,
  operatorId: string,
  abandonedCrpReleaseIds: readonly string[],
  packageIds: ReadonlyMap<string, string>,
  projectId: string,
  now: Date,
): Promise<void> {
  await tx.release.update({
    where: { id: releaseId },
    data: {
      revision: plan.revisionAfter,
      // 有新内容要投，提测回到「投递中」；哪怕之前已经有终局结论也要重新开。
      status: "dispatching",
      finishedAt: null,
      // 顺手把刚读到的进度写回去，页面与后人都能看到判定依据。
      crpWorkProgress: plan.workProgress,
      crpWorkProgressLabel: plan.workProgressLabel,
      crpWorkProgressSyncedAt: now,
    },
  });

  if (plan.appendedPackageNames.length > 0) {
    await tx.releaseUpdateRecord.create({
      data: {
        releaseId,
        operatorId,
        action: "append",
        packageNames: plan.appendedPackageNames,
        revisionBefore: plan.revisionBefore,
        revisionAfter: plan.revisionAfter,
        abandonedCrpReleaseIds: [],
        redispatchedPackageNames: plan.appendedPackageNames,
      },
    });
  }

  if (plan.replacedPackageNames.length > 0) {
    await tx.releaseUpdateRecord.create({
      data: {
        releaseId,
        operatorId,
        action: "replace",
        packageNames: plan.replacedPackageNames,
        revisionBefore: plan.revisionBefore,
        revisionAfter: plan.revisionAfter,
        abandonedCrpReleaseIds: [...abandonedCrpReleaseIds],
        redispatchedPackageNames: plan.redispatchedPackageNames,
      },
    });
  }

  // 换了 Commit 的包，把它记成「上次提测的提交」，与建提测那一侧保持一致。
  for (const round of plan.rounds) {
    if (round.reason === "downstream") {
      continue;
    }

    const packageId = packageIds.get(round.packageName);

    if (packageId === undefined) {
      continue;
    }

    await tx.projectSoftware.update({
      where: { projectId_packageId: { projectId, packageId } },
      data: { lastSubmittedCommit: round.snapshot.commitSha, lastSubmittedAt: now },
    });
  }
}

/**
 * 事务上限：固定开销 + 每条待放弃的 Release 一次最坏的 CRP 删除。
 *
 * 上限要在进事务之前定下来，而要知道「放弃几条」得先算计划，所以这里用一个必然不小于它的
 * 上界：当前轮的快照数（放弃清单是它的子集）。多算几条只是把超时放宽，代价为零。
 */
async function transactionTimeoutFor(releaseId: string): Promise<number> {
  const currentSnapshotCount = await prisma.releasePackageSnapshot.count({
    where: { releaseId, supersededById: null },
  });

  return TRANSACTION_BASE_TIMEOUT_MS + currentSnapshotCount * WORST_CASE_CRP_CALL_MS;
}

/**
 * 执行一次增量更新。
 *
 * 顺序固定，每一步都有理由：
 *
 * 1. 锁住提测这一行 —— 第二个并发更新排队或收到明确拒绝（MUST）；
 * 2. 算计划 —— 含现读 CRP 进度、拒绝已转测、算传递下游；
 * 3. 放弃下游的旧 CRP Release —— 删不掉就整体中止（MUST）；
 * 4. 写新轮、把旧轮标 `superseded`、改提测轮次与状态、写留痕，全在同一个事务里；
 * 5. 事务提交后推进一次 —— 复用 A12 的 `advanceRelease`，投递规则只有一份。
 *
 * 事务失败时有两件事要做：数据库那半边由回滚负责；CRP 侧已经删掉的 Release 回不来，
 * 要在事务退出（行锁释放）之后按 `compensateAbandoned()` 补偿，否则提测会显示成功而 CRP 缺包。
 *
 * 第 5 步在事务外：`advanceRelease` 自己会调 CRP 并写库，塞进同一个事务会和自己抢同一把锁。
 * 它失败不算更新失败：更新已经提交，提测状态是「投递中」，外部定时器会接着推。
 */
export async function applyReleaseUpdate(
  releaseId: string,
  input: ReleaseUpdateInput,
  options: ReleaseUpdateOptions,
): Promise<ReleaseUpdateResult> {
  const crp = resolveCrp(releaseId, options.network);
  const timeout = await transactionTimeoutFor(releaseId);

  /** CRP 侧已经删掉的旧 Release。事务失败时按这份记录决定补偿哪些包。 */
  const deletedCrpReleaseIds: string[] = [];

  const committed = await prisma
    .$transaction(
      async (tx) => {
        await lockRelease(tx, releaseId);

        const { plan, projectId, packageIds } = await buildUpdatePlan(
          releaseId,
          input,
          options,
          crp,
        );

        // 删一条记一条：CRP 侧的删除不会跟着数据库事务回滚。
        await abandonDownstream(crp, plan.abandoned, deletedCrpReleaseIds);

        const now = new Date();
        const created = await createRounds(tx, releaseId, plan);

        await supersedeOldRounds(tx, created, now);
        await writeUpdateRecords(
          tx,
          releaseId,
          plan,
          options.operatorId,
          deletedCrpReleaseIds,
          packageIds,
          projectId,
          now,
        );

        return { plan, abandonedCrpReleaseIds: [...deletedCrpReleaseIds] };
      },
      { timeout, maxWait: TRANSACTION_MAX_WAIT_MS },
    )
    .catch(async (error: unknown) => {
      try {
        await compensateAbandoned(releaseId, deletedCrpReleaseIds);
      } catch (compensationError) {
        console.error(
          `[releases] 提测 ${releaseId} 的放弃补偿也失败了，需要人工确认 CRP 侧缺哪些包`,
          compensationError,
        );
      }

      throw error;
    });

  let advance: AdvanceResult | null = null;
  let advanceError: string | null = null;

  try {
    advance = await advanceRelease(releaseId, { network: options.network });
  } catch (error) {
    advanceError = error instanceof Error ? error.message : String(error);
    console.error(`[releases] 更新之后推进投递失败（${releaseId}）`, error);
  }

  return {
    releaseId,
    revision: committed.plan.revisionAfter,
    plan: committed.plan,
    abandonedCrpReleaseIds: committed.abandonedCrpReleaseIds,
    advance,
    advanceError,
  };
}

// ---------------------------------------------------------------------------
// 页面数据
// ---------------------------------------------------------------------------

/**
 * 更新页要显示的内容：能不能改、现在有哪些包、还能补哪些包、每轮更新留下了什么。
 *
 * CRP 进度现读一次；读不到只影响「能不能改」的判断（页面显示原因），不让整页打不开。
 */
export async function loadReleaseUpdateView(
  releaseId: string,
  options: ReleaseUpdateViewOptions = {},
): Promise<ReleaseUpdateView> {
  const release = await loadReleaseForUpdate(releaseId);
  const [project, dispatch, records] = await Promise.all([
    loadReleaseProject(release.projectId),
    loadReleaseDispatch(releaseId),
    prisma.releaseUpdateRecord.findMany({
      where: { releaseId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        action: true,
        packageNames: true,
        revisionBefore: true,
        revisionAfter: true,
        abandonedCrpReleaseIds: true,
        redispatchedPackageNames: true,
        createdAt: true,
        operator: { select: { displayName: true } },
      },
    }),
  ]);

  let workProgress: number | null = null;
  let label: string | null = null;
  let workProgressError: string | null = null;

  try {
    const read = await readWorkProgress(resolveCrp(releaseId, options.network), release.crpTopicId);
    workProgress = read.workProgress;
    label = read.label;
  } catch (error) {
    workProgressError = error instanceof Error ? error.message : String(error);
  }

  const inside = new Set(dispatch.packages.map((item) => item.packageName));
  const dispatching = dispatch.packages.some((item) => item.snapshotStatus === "dispatching");

  return {
    releaseId: release.id,
    version: release.version,
    revision: release.revision,
    status: release.status,
    projectId: release.projectId,
    projectKey: project?.key ?? "",
    projectName: project?.name ?? "",
    crpTopicId: release.crpTopicId,
    workProgress,
    workProgressLabel: label,
    workProgressError,
    lockReason: lockReasonOf({ release, project, workProgress, label, dispatching }),
    packages: dispatch.packages,
    candidates: (project?.packages ?? [])
      .filter((item) => !inside.has(item.packageName))
      .map((item) => ({
        packageName: item.packageName,
        repoPath: item.repoPath,
        trackedBranch: item.trackedBranch,
      })),
    history: records.map((row) => ({
      id: row.id,
      action: row.action,
      packageNames: row.packageNames,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter,
      abandonedCrpReleaseIds: row.abandonedCrpReleaseIds,
      redispatchedPackageNames: row.redispatchedPackageNames,
      createdAt: row.createdAt,
      operatorName: row.operator.displayName,
    })),
  };
}

/** 现在能不能改。序列与 `applyReleaseUpdate` 的拒绝顺序一致，页面不会说「能改」而接口拒绝。 */
function lockReasonOf(input: {
  release: { status: string };
  project: { deletedAt: Date | null } | null;
  workProgress: number | null;
  label: string | null;
  dispatching: boolean;
}): string | null {
  if (input.release.status === "abandoned") {
    return "这条提测已经取消，不能再补包或换包。";
  }

  if (input.project === null || input.project.deletedAt !== null) {
    return "提测所属的项目不存在或已删除，不能再更新软件包。";
  }

  if (input.workProgress === null) {
    return "读不到 CRP 的工作流进度，无法判断是否已转测，更新会被拒绝。";
  }

  if (input.workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST) {
    return `这条提测已经转测（CRP 工作流进度 ${input.workProgress}：${input.label ?? "未知状态"}），转测之后不能再补包或换包。`;
  }

  if (input.dispatching) {
    return "有软件包正在投递，等这一轮投递结束再更新。";
  }

  return null;
}
