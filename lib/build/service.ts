/**
 * 向 CRP 投递提测、按依赖顺序推进、轮询构建结果（A12）。
 *
 * 一张提测的一生都在这一个模块里推进，**没有队列，也不依赖进程内定时器**：
 *
 * ```
 * pending ──建 Topic──> dispatching ──逐个投递──> building ──全部成功──> success
 *                            │                        │
 *                            └──有包失败（阻断下游）──┴──> failed / partial_failure
 * ```
 *
 * 推进的入口是 `advanceRelease(releaseId)`，它**可重入、幂等、每次只往前走一步**：
 *
 * 1. 还没有 Topic 就建一个（已有 `crpTopicId` 就不再建第二个，AC3）；
 * 2. 轮询已投递包的构建结果（`pollReleaseBuilds`，A14 复用同一个函数）；
 * 3. 有包失败就把它的下游全部阻断，并把提测判成 `failed` / `partial_failure`（AC2）；
 * 4. 否则投递**一个**「上游全部成功」的包（MUST NOT 并发投递依赖链）；
 * 5. 没有可投的包就把提测置为 `building`，等下一轮。
 *
 * 进程重启不丢进度：进度只存在数据库里（`release`、`release_package_snapshot`、
 * `release_repository_record`、`build_task`），下一轮从库里读出来继续推。
 * 外部定时器反复 `POST /api/jobs/build-dispatch`，用户手动触发走
 * `POST /api/releases/{id}/dispatch`，两条入口调的是同一个 `advanceRelease`。
 *
 * 投递参数全部取自快照（分支、Commit、提测版本），不回查仓库当前状态（MUST）：
 * 快照是审计记录，回查等于让实际投递内容与记录不一致。
 */

import { prisma } from "../db";
import {
  createCrpClient,
  createCrpClientFromEnv,
  CRP_DEFAULT_BASE_URL,
  CrpBusinessError,
  CrpInvalidParameterError,
  type CrpClient,
} from "../integrations/crp";
import {
  createShuttleClient,
  readShuttleEnv,
  SHUTTLE_DEFAULT_BASE_URL,
  type ShuttleClient,
  type ShuttleBuildTask,
} from "../integrations/shuttle";
import {
  CrpProjectNameError,
  describeCrpProjectName,
  resolveCrpProjectName,
} from "../packages/crpProject";
import { emitEvent } from "../webhook";
import {
  evaluateChain,
  type BlockedNode,
  type ChainNode,
  type ChainStatus,
} from "./chain";
import { createCrpCallRecorder, type CrpCallRecorder } from "./crpLog";
import { mapShuttleState, summarizeBuild, type BuildStateName } from "./status";

/**
 * 抢占的有效期。
 *
 * 「建 Topic」和「投递一个包」都是「先看状态、再调 CRP、最后写库」的三段式，中间没有事务能盖住
 * 一次外部请求。所以先用一条条件 UPDATE 抢占（状态从「待投递」改成「进行中」），抢到的那一次才去调 CRP。
 *
 * 抢占方如果中途挂掉，这条记录会停在「进行中」。超过这个时间还没写回结果，就认为那次调用已经不在了，
 * 允许下一位重新抢占；这个值要明显大于一次 CRP 调用的最坏耗时（超时 30 秒 × 4 次尝试）。
 */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/** 抢占超时的判定基准：`updatedAt` 早于这个时刻就算过期。 */
function staleClaimBefore(now: Date): Date {
  return new Date(now.getTime() - CLAIM_STALE_MS);
}

/** 提测状态，取值与 `release_status` 枚举一致。 */
export type ReleaseStateName =
  | "pending"
  | "dispatching"
  | "building"
  | "success"
  | "partial_failure"
  | "failed"
  | "abandoned";

/** 可预期的业务错误：`status` 直接对应接口状态码，`message` 原样给页面显示。 */
export class BuildError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BuildError";
    this.status = status;
  }
}

/**
 * 注入用的网络接线：只换掉接口地址与请求实现。
 *
 * 请求策略、重试、调用记录仍然走生产代码，被换掉的只有真正发出去的那一层。
 * 写法与仓库里其它注入点一致（`fetchImpl`、`CreateReleaseOptions.reader`），
 * 单测因此能跑完整条投递链路而不碰真实 CRP / Shuttle。
 */
export type BuildNetwork = {
  crpBaseUrl?: string;
  /** 注入时用的 token；给了就不再走登录。 */
  crpToken?: string;
  crpFetch?: typeof fetch;
  shuttleBaseUrl?: string;
  shuttleFetch?: typeof fetch;
};

export type BuildOptions = {
  /** 注入用。生产代码不传，按环境变量建客户端（缺凭据会直接报错，不退回匿名）。 */
  network?: BuildNetwork;
};

/**
 * 投递与轮询用到的那几个 CRP 与 Shuttle 能力。
 *
 * `getTopicWorkflow` 是 A14 轮询层同步 `crp_work_progress` 用的：建客户端的方式与投递层
 * 完全相同（同样挂 CRP 调用记录），所以两处共用这一份。
 */
type DispatchApis = {
  crp: Pick<
    CrpClient,
    | "createTopic"
    | "submitRelease"
    | "listReleases"
    | "deleteRelease"
    | "abandonTopic"
    | "getTopicWorkflow"
  >;
  shuttle: Pick<ShuttleClient, "listBuildTasks">;
};

type Resolved = {
  clients: DispatchApis;
  /** 调用记录器：投递某个包时用它把这段时间的调用归到这个包名下。 */
  recorder: CrpCallRecorder;
};

/**
 * 建客户端，并把调用记录器接到请求层上。
 *
 * 调用记录接在请求层而不是各个调用点：重试的每一次、登录请求、404 都会留下记录，
 * 逐个调用点手工记一定会漏。
 *
 * 导出给 `lib/build` 内的轮询层（A14）复用：它只多需要一项 `getTopicWorkflow`，
 * 不该为此再写一份建客户端的代码，也不该绕开调用记录。
 */
export function resolveClients(releaseId: string, options: BuildOptions): Resolved {
  const recorder = createCrpCallRecorder(releaseId);
  const network = options.network;

  const crp: DispatchApis["crp"] =
    network?.crpFetch === undefined
      ? createCrpClientFromEnv(process.env, { onRequest: recorder.observe })
      : createCrpClient({
          baseUrl: network.crpBaseUrl ?? CRP_DEFAULT_BASE_URL,
          token: network.crpToken ?? "injected",
          tokenPath: null,
          fetchImpl: network.crpFetch,
          onRequest: recorder.observe,
        });

  const shuttle: DispatchApis["shuttle"] =
    network?.shuttleFetch === undefined
      ? createShuttleClient(readShuttleEnv())
      : createShuttleClient({
          baseUrl: network.shuttleBaseUrl ?? SHUTTLE_DEFAULT_BASE_URL,
          fetchImpl: network.shuttleFetch,
        });

  return { clients: { crp, shuttle }, recorder };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

const SNAPSHOT_SELECT = {
  id: true,
  packageName: true,
  attempt: true,
  branch: true,
  commitSha: true,
  codeVersion: true,
  repoVersion: true,
  releaseVersion: true,
  status: true,
  repositoryRecord: { select: { crpReleaseId: true, crpBuildId: true } },
  buildTask: {
    select: {
      id: true,
      status: true,
      shuttleTaskId: true,
      blockedBySnapshotId: true,
      statusReason: true,
      jobs: { select: { arch: true, status: true } },
    },
  },
} as const;

/** 一条提测加它当前轮（未被替换）的快照。 */
function queryRelease(releaseId: string) {
  return prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      status: true,
      version: true,
      revision: true,
      projectId: true,
      crpTopicId: true,
      crpBranchId: true,
      finishedAt: true,
      project: {
        select: {
          key: true,
          name: true,
          workspaceId: true,
          baseline: { select: { crpBranchId: true, name: true } },
        },
      },
      // 只取当前轮：A17 会把旧轮标成 superseded，那些行不参与本次投递。
      snapshots: {
        where: { supersededById: null },
        orderBy: [{ packageName: "asc" }, { attempt: "desc" }],
        select: SNAPSHOT_SELECT,
      },
    },
  });
}

type LoadedRelease = NonNullable<Awaited<ReturnType<typeof queryRelease>>>;

async function loadRelease(releaseId: string): Promise<LoadedRelease> {
  const release = await queryRelease(releaseId);

  if (release === null) {
    throw new BuildError("提测记录不存在。", 404);
  }

  return release;
}

/** 已有终局的提测状态：不再推进。 */
const FINAL_RELEASE_STATES: ReadonlySet<ReleaseStateName> = new Set<ReleaseStateName>([
  "success",
  "partial_failure",
  "failed",
  "abandoned",
]);

/** 还要继续推进的提测状态：外部定时器按这三个状态挑活干。 */
export const ACTIVE_RELEASE_STATES: readonly ReleaseStateName[] = [
  "pending",
  "dispatching",
  "building",
];

/**
 * 每条提测里各个软件包的上游包名。
 *
 * 依赖边只有一份（`package_dependency`），按包名反查。清单外的上游不参与：那些包不在这次
 * 提测里，构不成先后关系。
 *
 * 导出给队列页（A14）复用：页面上「在等哪些上游」与投递判定必须用同一份口径，
 * 否则页面说「可以投了」而投递层说「还要等」，两边都没法解释。
 */
export async function loadUpstreamNames(
  packageNames: readonly string[],
): Promise<Map<string, string[]>> {
  if (packageNames.length === 0) {
    return new Map();
  }

  const packages = await prisma.package.findMany({
    where: { name: { in: [...packageNames] } },
    select: {
      name: true,
      dependencies: { select: { upstreamPackage: { select: { name: true } } } },
    },
  });

  const inside = new Set(packageNames);

  return new Map(
    packages.map((item) => [
      item.name,
      item.dependencies
        .map((edge) => edge.upstreamPackage.name)
        .filter((name) => inside.has(name)),
    ]),
  );
}

/**
 * 快照里的包名 → 投递时该用的 CRP 项目名。
 *
 * 快照存的是 Debian 源码包名，CRP 的项目名另有一列（`crpProjectName`），两者不一定相同。
 * 未登记的包按包名兜底：快照允许出现还没登记进软件包管理的包，这一列出现之前它们就是按包名投的。
 */
async function resolveSnapshotCrpProjectName(packageName: string): Promise<string> {
  const pkg = await prisma.package.findUnique({
    where: { name: packageName },
    select: { name: true, crpProjectName: true },
  });

  if (pkg === null) {
    return packageName;
  }

  try {
    return resolveCrpProjectName(pkg);
  } catch (error) {
    // 库里的 CRP 项目名不合法属于配置错误：翻成 409 并把原话带出去，
    // 否则路由只认 BuildError，人会看到 500「请查看服务端日志」，不知道去改哪个包的哪一列。
    if (error instanceof CrpProjectNameError) {
      throw new BuildError(`${error.message} 请在软件包管理里订正后再投递。`, 409);
    }

    throw error;
  }
}

/** 把一条提测当前轮的快照翻成依赖链上的一环。 */
async function loadChain(release: LoadedRelease): Promise<ChainNode[]> {
  const upstreams = await loadUpstreamNames(release.snapshots.map((item) => item.packageName));

  // 同一个包只保留最高轮次的一行：正常数据里只有一行，这里防止历史脏数据把链撑成两截。
  const seen = new Set<string>();

  return release.snapshots
    .filter((snapshot) => {
      if (seen.has(snapshot.packageName)) {
        return false;
      }
      seen.add(snapshot.packageName);
      return true;
    })
    .map((snapshot) => ({
      snapshotId: snapshot.id,
      packageName: snapshot.packageName,
      status: snapshot.status as ChainStatus,
      upstreamNames: upstreams.get(snapshot.packageName) ?? [],
    }));
}

// ---------------------------------------------------------------------------
// 轮询构建结果
// ---------------------------------------------------------------------------

/** 一次轮询的结论。 */
export type PollSummary = {
  /** 在 CRP 侧查到的已投递快照数。 */
  checked: number;
  /** 本次变为成功的包名。 */
  succeeded: string[];
  /** 本次变为失败的包名。 */
  failed: string[];
  /** 还在构建中的包名。 */
  building: string[];
};

function emptyPoll(): PollSummary {
  return { checked: 0, succeeded: [], failed: [], building: [] };
}

/**
 * 轮询一轮构建结果，把 Shuttle 的状态写回 `build_task` / `build_job`，并同步快照状态。
 *
 * 写成独立函数是因为 A14 构建队列页与定时刷新都要用它，不能各写一份。
 * 一次轮询的请求数是「1 + 已投递包数」：先向 CRP 取一次整条 Topic 的 Release 列表
 * （拿到各包的 `BuildID`），再按 `BuildID` 逐个问 Shuttle。
 *
 * 只回写、不判定提测结局：结局由 `advanceRelease` 看完整条链再定。
 */
export async function pollReleaseBuilds(
  releaseId: string,
  options: BuildOptions = {},
): Promise<PollSummary> {
  const { clients } = resolveClients(releaseId, options);

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      crpTopicId: true,
      snapshots: {
        where: { supersededById: null },
        orderBy: [{ packageName: "asc" }],
        select: {
          id: true,
          packageName: true,
          status: true,
          repositoryRecord: { select: { crpReleaseId: true } },
          buildTask: { select: { id: true, status: true, startedAt: true } },
        },
      },
    },
  });

  if (release === null) {
    throw new BuildError("提测记录不存在。", 404);
  }

  if (release.crpTopicId === null) {
    return emptyPoll();
  }

  const dispatched = release.snapshots.filter((item) => item.repositoryRecord !== null);

  if (dispatched.length === 0) {
    return emptyPoll();
  }

  const crpReleases = await clients.crp.listReleases(Number(release.crpTopicId));
  const byReleaseId = new Map(crpReleases.map((item) => [String(item.releaseId), item]));
  const summary = emptyPoll();
  const now = new Date();

  for (const snapshot of dispatched) {
    const crpRelease = byReleaseId.get(snapshot.repositoryRecord?.crpReleaseId ?? "");

    if (crpRelease === undefined) {
      // CRP 侧已经没有这条 Release（被人手工删了）：不动本地状态，等下一轮再看。
      continue;
    }

    summary.checked += 1;

    await prisma.releaseRepositoryRecord.update({
      where: { snapshotId: snapshot.id },
      data: {
        // 只有 CRP 真给了构建 ID 才写：偶尔回 0 时不要把上一次的好数据清掉。
        ...(crpRelease.buildId > 0 ? { crpBuildId: String(crpRelease.buildId) } : {}),
        crpReleaseState: crpRelease.raw.Status ?? null,
        crpStatusName: crpRelease.raw.StatusName ?? null,
        lastSyncedAt: now,
      },
    });

    const task =
      crpRelease.buildId > 0
        ? await findShuttleTask(clients.shuttle, crpRelease.buildId)
        : null;

    if (task === null) {
      // 构建任务还没出来（CRP 还在排队）：保持原状态，只记一次轮询时间。
      await prisma.buildTask.updateMany({
        where: { snapshotId: snapshot.id },
        data: { lastPolledAt: now },
      });
      summary.building.push(snapshot.packageName);
      continue;
    }

    const verdict = summarizeBuild({
      taskState: task.status,
      jobStates: task.jobs.map((job) => job.status),
      // 「任务成功、作业列表一直为空」原本没有出口，这里把等待起点与本次查询时间交给纯函数兜底。
      // 还没有构建任务行时先用本次查询时间：那一行就是这一轮建出来的，期限从这一刻算。
      waitingSince: snapshot.buildTask?.startedAt ?? now,
      observedAt: now,
    });

    await applyBuildResult({
      releaseId,
      snapshotId: snapshot.id,
      packageName: snapshot.packageName,
      task,
      status: verdict.status,
      reason: verdict.reason,
      previous: snapshot.buildTask?.status ?? null,
      now,
    });

    if (verdict.status === "success") {
      summary.succeeded.push(snapshot.packageName);
    } else if (verdict.status === "failed" || verdict.status === "canceled") {
      summary.failed.push(snapshot.packageName);
    } else {
      summary.building.push(snapshot.packageName);
    }
  }

  return summary;
}

/** 按构建 ID 去 Shuttle 取那一条构建任务；取不到返回 `null`。 */
async function findShuttleTask(
  shuttle: Pick<ShuttleClient, "listBuildTasks">,
  buildId: number,
): Promise<ShuttleBuildTask | null> {
  const page = await shuttle.listBuildTasks(buildId);

  // 只认任务 ID 完全相同的那一条：Shuttle 的过滤没生效时不去拿别人的构建充数。
  return page.tasks.find((task) => task.key === buildId) ?? null;
}

type BuildResultInput = {
  releaseId: string;
  snapshotId: string;
  packageName: string;
  task: ShuttleBuildTask;
  status: BuildStateName;
  reason: string | null;
  /** 回写之前的构建任务状态；用来判断要不要发事件。 */
  previous: string | null;
  now: Date;
};

/**
 * 把一次轮询的结果写回本地：构建任务、它下面的作业、快照状态。
 *
 * 事件只在**状态真的变了**的时候发：轮询是反复跑的，每次都发会让订阅方收到一堆重复通知。
 */
async function applyBuildResult(input: BuildResultInput): Promise<void> {
  const { status, now } = input;
  const finished = status === "success" || status === "failed" || status === "canceled";

  const task = await prisma.buildTask.upsert({
    where: { snapshotId: input.snapshotId },
    create: {
      releaseId: input.releaseId,
      snapshotId: input.snapshotId,
      shuttleTaskId: String(input.task.key),
      status,
      lastPolledAt: now,
      startedAt: now,
      finishedAt: finished ? now : null,
      statusReason: input.reason,
    },
    update: {
      shuttleTaskId: String(input.task.key),
      status,
      lastPolledAt: now,
      // 第一次看到实际构建时才记开始时间，之后反复轮询不再改动。
      ...(input.previous === null || input.previous === "pending" ? { startedAt: now } : {}),
      // 只在刚变成终态时记结束时间，之后再查不会把它往后推。
      ...(finished && input.previous !== status ? { finishedAt: now } : {}),
      statusReason: status === "failed" || status === "canceled" ? input.reason : null,
      // 有了真结论就不再是被阻断的：阻断说明要跟着清掉，否则页面会同时显示两种原因。
      blockedBySnapshotId: null,
    },
    select: { id: true },
  });

  for (const job of input.task.jobs) {
    const jobStatus = mapShuttleState(job.status);
    const jobDone =
      jobStatus === "success" || jobStatus === "failed" || jobStatus === "canceled";

    await prisma.buildJob.upsert({
      where: { shuttleJobId: String(job.id) },
      create: {
        buildTaskId: task.id,
        shuttleJobId: String(job.id),
        arch: job.arch,
        status: jobStatus,
        startedAt: now,
        finishedAt: jobDone ? now : null,
      },
      update: {
        arch: job.arch,
        status: jobStatus,
      },
    });

    if (jobDone) {
      // 只补一次结束时间：作业在终态会被反复查到，每次都写会把时间往后推。
      await prisma.buildJob.updateMany({
        where: { shuttleJobId: String(job.id), finishedAt: null },
        data: { finishedAt: now },
      });
    }
  }

  const snapshotStatus: ChainStatus =
    status === "success" ? "success" : finished ? "failed" : "building";

  await prisma.releasePackageSnapshot.update({
    where: { id: input.snapshotId },
    data: { status: snapshotStatus, statusChangedAt: now },
  });

  if (input.previous === status) {
    return;
  }

  const release = await prisma.release.findUnique({
    where: { id: input.releaseId },
    select: { project: { select: { workspaceId: true } } },
  });

  const payload = {
    releaseId: input.releaseId,
    buildTaskId: task.id,
    packageName: input.packageName,
    shuttleTaskId: String(input.task.key),

    reason: input.reason,
  };

  if (status === "success") {
    await emitEvent("build.succeeded", payload, {
      workspaceId: release?.project.workspaceId,
    });
    return;
  }

  if (finished) {
    await emitEvent("build.failed", payload, {
      workspaceId: release?.project.workspaceId,
    });
  }
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

/** 一次推进做了什么。接口直接把它返回给调用方。 */
export type AdvanceResult = {
  releaseId: string;
  action: "idle" | "topic_created" | "dispatched" | "finished" | "waiting";
  /** 推进之后的提测状态。 */
  status: ReleaseStateName;
  topicId: string | null;
  /** 本次投递的包名；`action` 不是 `dispatched` 时为 `null`。 */
  packageName: string | null;
  /** 本次被阻断的包。 */
  blocked: BlockedNode[];
  /** 本次轮询的结论；没有走轮询时为 `null`。 */
  polled: PollSummary | null;
};

/**
 * 把一条提测往前推一步。
 *
 * 只往前走一步，是「进程重启不丢进度」的前提：每次调用的进度都落在库里，
 * 中途挂掉最多丢掉这一步，下一轮重来；重复调用不会重复建 Topic、也不会重复投同一个包。
 */
export async function advanceRelease(
  releaseId: string,
  options: BuildOptions = {},
): Promise<AdvanceResult> {
  const resolved = resolveClients(releaseId, options);
  const loaded = await loadRelease(releaseId);
  const status = loaded.status as ReleaseStateName;

  if (FINAL_RELEASE_STATES.has(status)) {
    return {
      releaseId,
      action: "idle",
      status,
      topicId: loaded.crpTopicId,
      packageName: null,
      blocked: [],
      polled: null,
    };
  }

  if (loaded.crpTopicId === null) {
    return createTopicStep(loaded, resolved);
  }

  await releaseStaleClaims(releaseId);

  const polled = await pollReleaseBuilds(releaseId, { network: options.network });
  const fresh = await loadRelease(releaseId);
  const chain = await loadChain(fresh);
  const evaluation = evaluateChain(chain);

  if (evaluation.newlyBlocked.length > 0) {
    await applyBlocked(fresh, evaluation.newlyBlocked);
  }

  if (evaluation.outcome !== null) {
    return finalize(fresh, polled, evaluation.newlyBlocked, evaluation.outcome);
  }

  if (evaluation.next !== null) {
    const dispatched = await dispatchSnapshot(fresh, evaluation.next, resolved);

    if (dispatched === null) {
      // 这个包被另一路推进抢走了：这一次不投，等对方写回结果。
      return {
        releaseId,
        action: "waiting",
        status: "dispatching",
        topicId: fresh.crpTopicId,
        packageName: null,
        blocked: evaluation.newlyBlocked,
        polled,
      };
    }

    return {
      releaseId,
      action: "dispatched",
      status: "dispatching",
      topicId: fresh.crpTopicId,
      packageName: dispatched,
      blocked: evaluation.newlyBlocked,
      polled,
    };
  }

  // 没有可投的包、也没有终局结论：有包在构建，等下一轮。
  if (fresh.status !== "building") {
    await prisma.release.update({ where: { id: releaseId }, data: { status: "building" } });
  }

  return {
    releaseId,
    action: "waiting",
    status: "building",
    topicId: fresh.crpTopicId,
    packageName: null,
    blocked: evaluation.newlyBlocked,
    polled,
  };
}

/**
 * 把「抢占超时」的包退回待投递。
 *
 * 投递一个包要跨越一次 CRP 请求和一次写库，中间被打断（进程重启、发布、数据库短暂不可用）时，
 * 快照会停在「投递中」。`findNext` 只挑「待投递」的包，所以不主动退回来的话它永远回不到队列：
 * 既不会再被投递，也被 `outcomeOf` 当成「还在跑」而永远不给终局 —— 整条提测就此卡住。
 *
 * 只处理本提测：一条提测只有被推进时才会走到这里，卡住的提测本身仍在定时器的推进范围内。
 */
async function releaseStaleClaims(releaseId: string): Promise<void> {
  const demoted = await prisma.releasePackageSnapshot.updateMany({
    where: {
      releaseId,
      supersededById: null,
      status: "dispatching",
      updatedAt: { lt: staleClaimBefore(new Date()) },
    },
    data: { status: "pending" },
  });

  if (demoted.count > 0) {
    console.warn(
      `[build] 提测 ${releaseId} 有 ${demoted.count} 个包的投递抢占已超时，退回待投递后重新推进`,
    );
  }
}

/**
 * 建 Topic 这一步。
 *
 * 幂等的落点是 `release.crp_topic_id`（唯一约束）：已经有值就不再建第二个。
 * 基线分支 ID 取自项目选中的基线，写回 `release.crp_branch_id`，之后投递 Release 都用它。
 */
async function createTopicStep(loaded: LoadedRelease, resolved: Resolved): Promise<AdvanceResult> {
  const branchId = Number(loaded.crpBranchId ?? loaded.project.baseline.crpBranchId);

  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new BuildError(
      "提测找不到可用的 CRP 基线分支 ID，无法建立 Topic。请重新选择项目或同步基线后再试。",
      409,
    );
  }

  // 抢占：只允许一次调用去建 Topic。
  // 「读库确认没有 → 调 CRP → 写回」这三步之间没有事务能盖住一次外部请求，
  // 所以先用一条条件 UPDATE 把状态从「待投递」改成「投递中」，抢到的那一次才去建。
  // 抢不到说明另一个调用正在建，这一次直接返回，不会建出第二个 Topic（AC3）。
  const claim = await prisma.release.updateMany({
    where: {
      id: loaded.id,
      crpTopicId: null,
      OR: [
        { status: "pending" },
        // 上一次抢占的调用中途没了（进程重启、被打断）：超过抢占有效期就允许接手。
        { status: "dispatching", updatedAt: { lt: staleClaimBefore(new Date()) } },
      ],
    },
    data: { status: "dispatching" },
  });

  if (claim.count === 0) {
    return {
      releaseId: loaded.id,
      action: "waiting",
      status: "dispatching",
      topicId: null,
      packageName: null,
      blocked: [],
      polled: null,
    };
  }

  try {
    const created = await resolved.clients.crp.createTopic({
      name: `${loaded.project.key}-${loaded.version}`,
      branchId,
    });

    const topicId = String(created.topicId);

    await prisma.release.update({
      where: { id: loaded.id },
      data: { crpTopicId: topicId, crpBranchId: String(branchId), status: "dispatching" },
    });

    return {
      releaseId: loaded.id,
      action: "topic_created",
      status: "dispatching",
      topicId,
      packageName: null,
      blocked: [],
      polled: null,
    };
  } catch (error) {
    // 没建成就把抢占退回去，下一次调用重新来；不要留下「正在建 Topic」的假状态。
    await prisma.release.updateMany({
      where: { id: loaded.id, crpTopicId: null },
      data: { status: "pending" },
    });

    throw error;
  }
}

/**
 * 投递一个软件包。
 *
 * 参数全部来自快照：`branch`、`commitSha`、`releaseVersion`（即 CRP 的 Tag）三样都按快照原样传，
 * 不回查仓库当前状态（MUST）。`changeLogMode` 固定为 `false`，让 CRP 用我们给的版本号，
 * 而不是它自己生成（见 `lib/integrations/crp/FINDINGS.md`）。
 *
 * 唯一例外是「这个包在 CRP 里叫什么名字」：快照存的是 Debian 源码包名，投递要用 CRP 项目名，
 * 两者不一定相同（`crpProjectName`），所以按包名读一次登记的软件包来解析。
 * 投递与认领用同一个解析结果，不各查一遍。
 */
async function dispatchSnapshot(
  release: LoadedRelease,
  node: ChainNode,
  resolved: Resolved,
): Promise<string | null> {
  const snapshot = release.snapshots.find((item) => item.id === node.snapshotId);

  if (snapshot === undefined) {
    throw new BuildError("这一轮快照已经不存在，请刷新后重试。", 409);
  }

  // 投递出去的名字是 CRP 项目名，不是包名。解析要放在抢占之前：登记的 CRP 项目名不合法时
  // 直接失败，不把快照留在「投递中」等抢占超时。
  const crpProjectName = await resolveSnapshotCrpProjectName(snapshot.packageName);

  // 抢占这个包：并发推进时只有一方能把它从「待投递」改成「投递中」，另一方什么也不投，
  // 否则同一个包会向 CRP 发出两条 Release（本地却只记得后一条）。
  // 「投递中」的行不会一直卡住：抢占超时的会在 advanceRelease 里被 releaseStaleClaims 退回待投递。
  const claim = await prisma.releasePackageSnapshot.updateMany({
    where: { id: snapshot.id, status: "pending" },
    data: { status: "dispatching" },
  });

  if (claim.count === 0) {
    return null;
  }

  const topicId = Number(release.crpTopicId);
  const branchId = Number(release.crpBranchId);

  // 投递之前先问一趟 CRP：这个包是不是已经投出去过。
  // 两种情况下会有：上一次投递发出去之后、写本地记录之前被打断；或者请求超时但其实 CRP 已经收下。
  // 认出同一条就补写本地记录，不再发第二条 —— CRP 同一个 Topic 里同一分支只允许一条 Release。
  const adopted = await adoptExistingRelease(release, snapshot, resolved, topicId, crpProjectName);

  if (adopted) {
    return snapshot.packageName;
  }

  // 投递这一个包的请求都记在它名下；投递结束立刻恢复，避免后面的调用被记到它头上。
  resolved.recorder.scopeToSnapshot(snapshot.id);

  let submitted;

  try {
    submitted = await resolved.clients.crp.submitRelease({
      topicId,
      projectName: crpProjectName,
      branch: snapshot.branch,
      commit: snapshot.commitSha,
      branchId,
      tag: snapshot.releaseVersion,
      changeLogMode: false,
    });
  } catch (error) {
    // 显然没投成：把这个包退回「待投递」，下一次推进重新投；不要留下「投递中」的假状态。
    // 注意这里只管 submitRelease 自己抛的错；投递成功之后的写库失败由「抢占超时 + 接手」恢复。
    await prisma.releasePackageSnapshot.updateMany({
      where: { id: snapshot.id, status: "dispatching" },
      data: { status: "pending" },
    });

    // 投递失败时，错误信息里带上「这次用的是哪个 CRP 项目名」：名字与包名不同时，
    // 只看到 `kwin` 或只看到 CRP 那个陌生的项目名，都判断不出是配置错了还是 CRP 改了名。
    const target = `投递「${snapshot.packageName}」，CRP 项目名${describeCrpProjectName(snapshot.packageName, crpProjectName)}`;

    // 本地校验就判定参数非法（例如快照里的 Tag 格式不对）时，不要当成「CRP 挂了」报 502。
    if (error instanceof CrpInvalidParameterError) {
      throw new BuildError(`${target}的参数不合法：${error.message}`, 409);
    }

    if (error instanceof CrpBusinessError) {
      // 5xx 是 CRP 服务端自己的异常（响应体恰好带了 message 也会走到这个类），不能描述成
      // 「配置被拒绝」；补上目标信息后按原状态抛出，路由那边仍然回 502，让调用方稍后重试。
      if (error.status !== undefined && error.status >= 500) {
        throw new CrpBusinessError(`${target}失败：${error.message}`, {
          status: error.status,
          responseSnippet: error.responseSnippet,
        });
      }

      // 4xx 才是 CRP 明确拒绝（最常见的是按名字找不到项目、已经有一条同样的 Release）：
      // 原话带出去并说明目标，重试也没用。
      throw new BuildError(`${target}被 CRP 拒绝：${error.message}`, 409);
    }

    throw error;
  } finally {
    resolved.recorder.scopeToSnapshot(null);
  }

  const crpReleaseId = String(submitted.releaseId);
  const taskId = await recordSubmissionWithAlert({
    release,
    snapshot,
    crpReleaseId,
    crpBuildId: null,
  });

  await emitEvent(
    "build.started",
    {
      releaseId: release.id,
      buildTaskId: taskId,
      packageName: snapshot.packageName,
      crpReleaseId,
      branch: snapshot.branch,
      commitSha: snapshot.commitSha,
      releaseVersion: snapshot.releaseVersion,
    },
    { workspaceId: release.project.workspaceId },
  );

  return snapshot.packageName;
}

/**
 * 认领 CRP 侧已经存在的投递：同一个包、同一个分支、同一个 Commit、同一个提测版本才算同一条。
 *
 * 四个条件都要对：只按包名认，会把上一次不同 Commit 的 Release 错认成这一次的。
 * 「包名」这里指 CRP 项目名 —— 与投递用的是同一个解析结果（由调用方算好传进来），
 * 否则认领会拿 Debian 包名去比 CRP 的项目名，永远认不出来，同一个包会被投第二遍。
 *
 * 另外还要确认这条 Release 没有已经挂在本地**别的**那一轮快照上：A17 换包、补包之后，
 * 旧轮次的 Release 可能还留在 CRP 侧，参数与新轮逐字相同。只看四个字段会把它认领成这一轮的，
 * 结果要么把旧构建挂到新轮上，要么撞本地 `crp_release_id` 唯一约束、每 5 分钟报错一次。
 * 这种情形按「CRP 侧没有」处理，让投递层正常发一条新的。
 *
 * 返回 `true` 表示已经认领（不再重复投递），`false` 表示 CRP 侧没有，需要正常投递。
 *
 * 补写记录时不发 `build.started`：那次投递在中断之前已经发过事件了，重发会让订阅方收到重复通知。
 * 这条取舍写在 `docs/WEBHOOK.md` 的「认领不重发构建开始事件」一节。
 */
async function adoptExistingRelease(
  release: LoadedRelease,
  snapshot: LoadedRelease["snapshots"][number],
  resolved: Resolved,
  topicId: number,
  /** 这个包在 CRP 里的项目名，由调用方按 `crpProjectName` 解析好传进来。 */
  crpProjectName: string,
): Promise<boolean> {
  const topicReleases = await resolved.clients.crp.listReleases(topicId);
  const existing = topicReleases.find(
    (item) =>
      item.projectName === crpProjectName &&
      item.branch === snapshot.branch &&
      item.commit === snapshot.commitSha &&
      item.tag === snapshot.releaseVersion,
  );

  if (existing === undefined) {
    return false;
  }

  const crpReleaseId = String(existing.releaseId);
  const bound = await prisma.releaseRepositoryRecord.findUnique({
    where: { crpReleaseId },
    select: { snapshotId: true },
  });

  if (bound !== null && bound.snapshotId !== snapshot.id) {
    // 这条 Release 已经属于本地另一轮快照（旧轮留下的），不能认领成本轮的。
    return false;
  }

  await recordSubmissionWithAlert({
    release,
    snapshot,
    crpReleaseId,
    crpBuildId: existing.buildId > 0 ? String(existing.buildId) : null,
  });

  return true;
}

/**
 * 记下一次投递，写库失败时先发一条 `build.claim_failed` 告警再抛出。
 *
 * 「抢占超时 + 接手」能把这个包退回待投递，所以数据异常（例如 `crp_release_id` 唯一约束冲突）
 * 不会让提测卡死；但它会每 5 分钟重来一次，只在进程日志里留一行谁也看不见。
 * 告警走仓库已有的 Webhook 事件机制，订阅方据此发现「这条提测一直投不出去」。
 */
async function recordSubmissionWithAlert(
  input: Parameters<typeof recordSubmission>[0],
): Promise<string> {
  try {
    return await recordSubmission(input);
  } catch (error) {
    const full = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(
      0,
      500,
    );

    // 告警正文只留最后一行（真正的原因，例如「唯一约束冲突」）：
    // 像 Prisma 那样把整段调用栈和文件路径推给外部系统，订阅方读不出结论。
    const reason = (full.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? full).slice(
      0,
      300,
    );

    console.error(
      `[build] 提测 ${input.release.id} 的包 ${input.snapshot.packageName} 认领写库失败：${full}`,
    );

    await emitEvent(
      "build.claim_failed",
      {
        releaseId: input.release.id,
        snapshotId: input.snapshot.id,
        packageName: input.snapshot.packageName,
        crpReleaseId: input.crpReleaseId,
        reason,
      },
      { workspaceId: input.release.project.workspaceId },
    );

    throw error;
  }
}

/**
 * 记下一次投递：仓库记录、构建任务、快照转 `building`，三件事在同一个事务里。
 *
 * 放在一个事务里，是为了不出现「有仓库记录但没有构建任务」这类半截状态；
 * 事务整体失败时快照会留在「投递中」，由下一次推进按「抢占超时 + 接手」补回来。
 */
async function recordSubmission(input: {
  release: LoadedRelease;
  snapshot: LoadedRelease["snapshots"][number];
  crpReleaseId: string;
  crpBuildId: string | null;
}): Promise<string> {
  const { release, snapshot, crpReleaseId, crpBuildId } = input;
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    await tx.releaseRepositoryRecord.upsert({
      where: { snapshotId: snapshot.id },
      create: {
        releaseId: release.id,
        snapshotId: snapshot.id,
        crpReleaseId,
        crpBuildId,
      },
      update: {
        crpReleaseId,
        crpBuildId,
        crpReleaseState: null,
        crpStatusName: null,
        lastSyncedAt: now,
      },
    });

    const task = await tx.buildTask.upsert({
      where: { snapshotId: snapshot.id },
      create: {
        releaseId: release.id,
        snapshotId: snapshot.id,
        status: "pending",
        lastPolledAt: now,
      },
      update: {
        status: "pending",
        shuttleTaskId: null,
        startedAt: null,
        finishedAt: null,
        blockedBySnapshotId: null,
        statusReason: null,
        lastPolledAt: now,
      },
      select: { id: true },
    });

    await tx.releasePackageSnapshot.update({
      where: { id: snapshot.id },
      data: { status: "building", statusChangedAt: now },
    });

    return task;
  });

  return created.id;
}

/**
 * 把上游失败的后果写下来：被阻断的包建一条「失败」的构建任务，写明是谁造成的。
 *
 * 不让它停在「等待」状态：页面要能直接回答「这个包为什么没投」，而不是让人去猜。
 */
async function applyBlocked(release: LoadedRelease, blocked: readonly BlockedNode[]): Promise<void> {
  const now = new Date();

  for (const item of blocked) {
    const task = await prisma.buildTask.upsert({
      where: { snapshotId: item.snapshotId },
      create: {
        releaseId: release.id,
        snapshotId: item.snapshotId,
        status: "failed",
        blockedBySnapshotId: item.blockedBySnapshotId,
        statusReason: item.reason,
        lastPolledAt: now,
      },
      update: {
        status: "failed",
        blockedBySnapshotId: item.blockedBySnapshotId,
        statusReason: item.reason,
      },
      select: { id: true },
    });

    await prisma.releasePackageSnapshot.update({
      where: { id: item.snapshotId },
      data: { status: "failed", statusChangedAt: now },
    });

    await emitEvent(
      "build.failed",
      {
        releaseId: release.id,
        buildTaskId: task.id,
        packageName: item.packageName,
        blockedByPackage: item.blockedByName,
        blockedBySnapshotId: item.blockedBySnapshotId,
        reason: item.reason,
      },
      { workspaceId: release.project.workspaceId },
    );
  }
}

/** 给出终局结论并落库。 */
async function finalize(
  release: LoadedRelease,
  polled: PollSummary,
  blocked: readonly BlockedNode[],
  outcome: "success" | "partial_failure" | "failed",
): Promise<AdvanceResult> {
  const now = new Date();

  await prisma.release.update({
    where: { id: release.id },
    data: { status: outcome, finishedAt: now },
  });

  const totals = await countSnapshotStatuses(release.id);

  await emitEvent(
    "release.status_synced",
    {
      releaseId: release.id,
      status: outcome,
      succeededCount: totals.success,
      failedCount: totals.failed,
      packageCount: totals.total,
    },
    { workspaceId: release.project.workspaceId },
  );

  return {
    releaseId: release.id,
    action: "finished",
    status: outcome,
    topicId: release.crpTopicId,
    packageName: null,
    blocked: [...blocked],
    polled,
  };
}

/** 当前轮的快照按状态计数，给终局事件的正文用。 */
async function countSnapshotStatuses(
  releaseId: string,
): Promise<{ total: number; success: number; failed: number }> {
  const where = { releaseId, supersededById: null };
  const [total, success, failed] = await Promise.all([
    prisma.releasePackageSnapshot.count({ where }),
    prisma.releasePackageSnapshot.count({ where: { ...where, status: "success" } }),
    prisma.releasePackageSnapshot.count({ where: { ...where, status: "failed" } }),
  ]);

  return { total, success, failed };
}

// ---------------------------------------------------------------------------
// 重试与取消
// ---------------------------------------------------------------------------

export type RetryResult = {
  releaseId: string;
  /** 被删掉旧 Release、重新排队的包（真正构建失败的）。 */
  resetPackageNames: string[];
  /** 被解除阻断、重新排队的包。 */
  unblockedPackageNames: string[];
  /** 没能重投的包，带原因；这些包保持原状，可以稍后再点一次重试。 */
  failures: Array<{ packageName: string; reason: string }>;
  /** 重投之后立刻推进一次的结果。 */
  advance: AdvanceResult;
};

/**
 * 重投失败的构建任务。
 *
 * 语义是「原样重投」，不是 CRP 的重试接口 —— 那个接口在当前部署上一律 404
 * （见 `lib/integrations/crp/FINDINGS.md`）。做法是：
 *
 * 1. 删掉这个包在 CRP 侧的旧 Release；
 * 2. 删掉本地的仓库记录与构建任务，把快照退回 `pending`；
 * 3. 立刻推进一次，按**同一份快照参数**重新投递。
 *
 * 被阻断的包不单独重投：它自己没有失败，上游重投成功后会自动回到队列。
 *
 * 一次提测里可能有多个失败包，逐个处理、逐个记账：某个包的旧 Release 删不掉（CRP 连不上、
 * 已经被人手工删了）不中断其它包，原因汇总到返回体的 `failures` 里。提测状态在处理前就放回
 * `dispatching`，所以哪怕中途出意外，定时器也会继续推进它，不会卡在终局状态里。
 */
export async function retryFailedTasks(
  releaseId: string,
  options: BuildOptions = {},
): Promise<RetryResult> {
  const resolved = resolveClients(releaseId, options);
  const release = await loadRelease(releaseId);

  if (release.crpTopicId === null) {
    throw new BuildError("这次提测还没有建立 CRP Topic，没有可重试的构建。", 409);
  }

  // 先只挑出要做的事，不动任何数据：一个可重试的包都没有时，状态不该有任何变化。
  const failedTargets = release.snapshots.filter(
    (snapshot) =>
      snapshot.buildTask !== null &&
      snapshot.buildTask.blockedBySnapshotId === null &&
      snapshot.buildTask.status === "failed",
  );
  const blockedTargets = release.snapshots.filter(
    (snapshot) =>
      snapshot.buildTask !== null && snapshot.buildTask.blockedBySnapshotId !== null,
  );

  if (failedTargets.length === 0 && blockedTargets.length === 0) {
    throw new BuildError("这次提测没有失败的构建任务，不需要重试。", 409);
  }

  const now = new Date();

  // 先放回「投递中」：后面哪怕中断，定时器也会继续推进，不会停在终局状态里没人管。
  await prisma.release.update({
    where: { id: releaseId },
    data: { status: "dispatching", finishedAt: null },
  });

  const resetPackageNames: string[] = [];
  const unblockedPackageNames: string[] = [];
  const failures: RetryResult["failures"] = [];

  for (const snapshot of failedTargets) {
    const task = snapshot.buildTask;

    if (task === null) {
      continue;
    }

    try {
      if (snapshot.repositoryRecord !== null) {
        await resolved.clients.crp.deleteRelease(Number(snapshot.repositoryRecord.crpReleaseId));
      }

      await prisma.$transaction(async (tx) => {
        // 构建作业随构建任务一起删（外键 CASCADE）。
        await tx.buildTask.delete({ where: { id: task.id } });
        await tx.releaseRepositoryRecord.deleteMany({ where: { snapshotId: snapshot.id } });
        await tx.releasePackageSnapshot.update({
          where: { id: snapshot.id },
          data: { status: "pending", statusChangedAt: now },
        });
      });

      resetPackageNames.push(snapshot.packageName);
    } catch (error) {
      failures.push({
        packageName: snapshot.packageName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 被阻断的包退回「还没投递」：它的构建任务本来就是为说明阻断原因而建的，解除后不再成立。
  for (const snapshot of blockedTargets) {
    try {
      if (snapshot.buildTask !== null) {
        await prisma.buildTask.delete({ where: { id: snapshot.buildTask.id } });
      }

      await prisma.releasePackageSnapshot.update({
        where: { id: snapshot.id },
        data: { status: "pending", statusChangedAt: now },
      });

      unblockedPackageNames.push(snapshot.packageName);
    } catch (error) {
      failures.push({
        packageName: snapshot.packageName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const advance = await advanceRelease(releaseId, { network: options.network });

  return { releaseId, resetPackageNames, unblockedPackageNames, failures, advance };
}

export type CancelResult = {
  releaseId: string;
  /** CRP 侧删掉的 Release ID。 */
  deletedReleaseIds: string[];
  /** 放弃掉的主题 ID；还没建 Topic 时为 `null`。 */
  abandonedTopicId: string | null;
  /** 删除或放弃失败的项，带原因。 */
  failures: Array<{ target: string; reason: string }>;
};

/**
 * 取消整个提测。
 *
 * CRP 没有删除 Topic 的能力（`DELETE /api/topics/{id}` 返回 200 但不做事，见 FINDINGS.md），
 * 所以「取消」是两件事：逐个删掉 Topic 里的 Release，再把 Topic 标成已放弃。
 * 快照统一置 `abandoned`，提测状态置 `abandoned`。
 *
 * 单个 Release 删除失败不中断整体取消：CRP 侧已经没了的 Release 会回 404，
 * 那本来就是想要的结果，不该让整次取消卡住。
 */
export async function cancelRelease(
  releaseId: string,
  options: BuildOptions = {},
): Promise<CancelResult> {
  const { clients } = resolveClients(releaseId, options);
  const release = await loadRelease(releaseId);

  if (release.status === "abandoned") {
    throw new BuildError("这次提测已经取消过了。", 409);
  }

  const deletedReleaseIds: string[] = [];
  const failures: Array<{ target: string; reason: string }> = [];

  for (const snapshot of release.snapshots) {
    const record = snapshot.repositoryRecord;

    if (record === null) {
      continue;
    }

    try {
      await clients.crp.deleteRelease(Number(record.crpReleaseId));
      deletedReleaseIds.push(record.crpReleaseId);
    } catch (error) {
      failures.push({
        target: `release:${record.crpReleaseId}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let abandonedTopicId: string | null = null;

  if (release.crpTopicId !== null) {
    try {
      await clients.crp.abandonTopic(Number(release.crpTopicId));
      abandonedTopicId = release.crpTopicId;
    } catch (error) {
      failures.push({
        target: `topic:${release.crpTopicId}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.releasePackageSnapshot.updateMany({
      where: { releaseId, supersededById: null },
      data: { status: "abandoned", statusChangedAt: now },
    });

    await tx.release.update({
      where: { id: releaseId },
      data: { status: "abandoned", crpTopicAbandoned: true, finishedAt: now },
    });
  });

  return { releaseId, deletedReleaseIds, abandonedTopicId, failures };
}

// ---------------------------------------------------------------------------
// 详情（A13 详情页合入前用它满足 AC4）
// ---------------------------------------------------------------------------

/** 一个软件包的投递参数与当前进展。 */
export type DispatchPackageView = {
  packageName: string;
  attempt: number;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  snapshotStatus: string;
  /** CRP 侧 Release ID；还没投递成功时为 `null`。 */
  crpReleaseId: string | null;
  /** CRP Release 上的 `BuildID`；还没查到构建时为 `null`。 */
  crpBuildId: string | null;
  buildStatus: string | null;
  /** 失败或阻断的原因。 */
  statusReason: string | null;
  /** 因哪个包失败而阻断；不是被阻断的为 `null`。 */
  blockedByPackage: string | null;
  jobs: Array<{ arch: string; status: string }>;
};

export type ReleaseDispatchView = {
  releaseId: string;
  version: string;
  revision: number;
  status: ReleaseStateName;
  projectId: string;
  crpTopicId: string | null;
  crpBranchId: string | null;
  finishedAt: Date | null;
  packages: DispatchPackageView[];
};

/** 一条提测的投递详情：每个包投了什么参数、CRP 给了什么 Release ID、现在什么状态。 */
export async function loadReleaseDispatch(releaseId: string): Promise<ReleaseDispatchView> {
  const release = await loadRelease(releaseId);
  const nameBySnapshotId = new Map(
    release.snapshots.map((item) => [item.id, item.packageName]),
  );

  return {
    releaseId: release.id,
    version: release.version,
    revision: release.revision,
    status: release.status as ReleaseStateName,
    projectId: release.projectId,
    crpTopicId: release.crpTopicId,
    crpBranchId: release.crpBranchId,
    finishedAt: release.finishedAt,
    packages: release.snapshots.map((snapshot) => ({
      packageName: snapshot.packageName,
      attempt: snapshot.attempt,
      branch: snapshot.branch,
      commitSha: snapshot.commitSha,
      codeVersion: snapshot.codeVersion,
      repoVersion: snapshot.repoVersion,
      releaseVersion: snapshot.releaseVersion,
      snapshotStatus: snapshot.status,
      crpReleaseId: snapshot.repositoryRecord?.crpReleaseId ?? null,
      crpBuildId: snapshot.repositoryRecord?.crpBuildId ?? null,
      buildStatus: snapshot.buildTask?.status ?? null,
      statusReason: snapshot.buildTask?.statusReason ?? null,
      blockedByPackage:
        snapshot.buildTask?.blockedBySnapshotId === null ||
        snapshot.buildTask?.blockedBySnapshotId === undefined
          ? null
          : (nameBySnapshotId.get(snapshot.buildTask.blockedBySnapshotId) ?? null),
      jobs: (snapshot.buildTask?.jobs ?? []).map((job) => ({
        arch: job.arch,
        status: job.status,
      })),
    })),
  };
}

/** 只要归属信息时用它：接口先查工作区再做权限判定，不信任请求里传来的工作区。 */
export async function findReleaseScope(
  releaseId: string,
): Promise<{ id: string; projectId: string; workspaceId: string; version: string } | null> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      projectId: true,
      version: true,
      project: { select: { workspaceId: true } },
    },
  });

  if (release === null) {
    return null;
  }

  return {
    id: release.id,
    projectId: release.projectId,
    workspaceId: release.project.workspaceId,
    version: release.version,
  };
}
