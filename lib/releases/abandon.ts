/**
 * 放弃提测主题（MKACG-950）：把 CRP 上的 Topic 就地清理掉，不必去 CRP 页面手工点。
 *
 * 演练与验收会在 CRP 的交付分支上留下测试主题。平台以前只能放弃单个 Release（A17 重投时用），
 * 没有放弃整个 Topic 的能力；这里补的就是那一步。
 *
 * 三条硬约束：
 *
 * 1. **只放弃主题，不动 Release**（MUST NOT）：不删任何 Release，也不碰快照。
 *    这与投递页的「取消提测」（逐个删 Release + 放弃 Topic）是两个动作，不能混。
 *    因此它只用于**从 CRP 导入**的提测：导入的主题里 Release 是别人投的，只能动主题。
 *    平台自己创建的提测要连产物一起清，走「取消提测」。
 * 2. **先 GET 再 PUT 完整对象**（MUST）：`lib/integrations/crp/topics.ts` 的 `abandonTopic`
 *    已经按实测结论这么做，这里只调它，不在别处手搓请求。
 * 3. **未转测才能放弃**（MUST）：以服务端现读的 `WorkProgress` 为准，`>= 20` 直接拒绝；
 *    读不到进度同样拒绝，不默认放行。页面上的禁用只是提示。
 *
 * 失败时本地状态一律不动：CRP 写成功之后才在一个事务里改 `release` 与写审计行。
 */

import {
  createCrpCallRecorder,
  type BuildNetwork,
} from "../build";
import { prisma } from "../db";
import {
  createCrpClient,
  createCrpClientFromEnv,
  CRP_DEFAULT_BASE_URL,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  workProgressLabel,
  type CrpClient,
} from "../integrations/crp";
import { ReleaseError } from "./service";

/** 放弃主题用到的两个 CRP 能力。 */
type AbandonCrpApis = Pick<CrpClient, "getTopicWorkflow" | "abandonTopic">;

/**
 * 建 CRP 客户端，并把调用记录挂到请求层上。
 *
 * 读进度与放弃主题都会发请求，它们要能在 `crp_call_log` 里查到，
 * 写法与 `lib/releases/update.ts` 的同名函数一致。
 */
function resolveCrp(
  releaseId: string,
  network: BuildNetwork | undefined,
): AbandonCrpApis {
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

export type AbandonTopicOptions = {
  /** 注入用：单测换掉 CRP 的网络层，其余代码照旧。 */
  network?: BuildNetwork;
};

/** 一次成功放弃的结果。 */
export type AbandonedTopic = {
  releaseId: string;
  topicId: string;
  /** CRP 上这个主题的名字，取自放弃前 GET 回来的对象。 */
  topicName: string;
  /** 放弃成功的时间，与审计行的时间是同一个值。 */
  abandonedAt: Date;
};
/** 平台创建的提测不提供「放弃提测主题」，原因只有一句，页面与接口共用。 */
const PLATFORM_SOURCE_MESSAGE =
  "这条提测是在平台上创建的：它的 Release 要连同主题一起清理，走「取消提测」。"
  + "「放弃提测主题」只用于从 CRP 导入的提测。";

/**
 * 「放弃主题」现在能不能做；不能做时给出给人看的原因。
 *
 * 页面用它决定按钮禁用与提示，`GET /api/releases/{id}/abandon` 用它回答 `canAbandon`。
 * 判定顺序与 `abandonReleaseTopic` 的拒绝顺序一致，页面不会说「能放弃」而接口拒绝。
 * 它只是提示：真正能不能放弃由服务端现读工作流进度后再定一次。
 */
export function abandonTopicLockReason(input: {
  source: string;
  status: string;
  crpTopicId: string | null;
  crpTopicAbandoned: boolean | null;
  workProgress: number | null;
  workProgressLabel: string | null;
}): string | null {
  // 按来源分流：只会显示一个动作，平台创建的这条走「取消提测」，这里不给入口。
  if (input.source !== "imported") {
    return PLATFORM_SOURCE_MESSAGE;
  }

  if (input.crpTopicId === null) {
    return "这条提测还没有建 Topic（尚未投递），没有可放弃的主题。";
  }

  if (input.crpTopicAbandoned === true || input.status === "abandoned") {
    return "这个主题已经放弃了，不能重复放弃。";
  }

  if (input.workProgress === null) {
    return "读不到 CRP 的工作流进度，无法判断是否已转测，放弃会被拒绝。";
  }

  if (input.workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST) {
    return (
      `这条提测已经转测（CRP 工作流进度 ${input.workProgress}：` +
      `${input.workProgressLabel ?? "未知状态"}），转测之后不能再放弃主题。`
    );
  }

  return null;
}

/**
 * 放弃一条提测的 CRP 主题。
 *
 * 顺序是：读库里这条提测 → 现读 CRP 工作流进度 → `abandonTopic`（GET 完整对象 + PUT 回写）
 * → 一个事务里改本地状态并写审计行。CRP 那一步失败就不写任何本地数据（MUST NOT）。
 */
export async function abandonReleaseTopic(
  releaseId: string,
  operatorId: string,
  options: AbandonTopicOptions = {},
): Promise<AbandonedTopic> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      source: true,
      status: true,
      revision: true,
      crpTopicId: true,
      crpTopicAbandoned: true,
    },
  });

  if (release === null) {
    throw new ReleaseError("提测记录不存在。", 404);
  }

  // MUST：只对导入的提测生效。平台自己投的 Release 由「取消提测」一并清理，
  // 只放弃主题会给它们留一个已放弃的主题。页面不显示这个入口，接口这一层也拒绝。
  if (release.source !== "imported") {
    throw new ReleaseError(PLATFORM_SOURCE_MESSAGE, 409);
  }

  if (release.crpTopicId === null) {
    throw new ReleaseError(
      "这条提测还没有建 Topic（尚未投递），没有可放弃的主题。",
      409,
    );
  }

  if (release.crpTopicAbandoned === true || release.status === "abandoned") {
    throw new ReleaseError("这个主题已经放弃了，不能重复放弃。", 409);
  }

  const crp = resolveCrp(releaseId, options.network);
  const topicId = release.crpTopicId;

  let workProgress: number;

  try {
    const workflow = await crp.getTopicWorkflow(Number(topicId));
    workProgress = workflow.workProgress;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[releases] 放弃主题前读 CRP 工作流进度失败（topic ${topicId}）`, error);
    throw new ReleaseError(
      `读不到 CRP 的工作流进度（${message}），无法判断这条提测是否已经转测，这次放弃已取消。`,
      502,
    );
  }

  if (workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST) {
    throw new ReleaseError(
      `这条提测已经转测（CRP 工作流进度 ${workProgress}：${workProgressLabel(workProgress)}），` +
        "转测之后不能再放弃主题。",
      409,
    );
  }

  // 放弃失败时这里直接抛出，后面的本地回写一步都不会执行。
  const topic = await crp.abandonTopic(Number(topicId));
  const abandonedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.release.update({
      where: { id: releaseId },
      data: { status: "abandoned", crpTopicAbandoned: true, finishedAt: abandonedAt },
    });

    await tx.releaseUpdateRecord.create({
      data: {
        releaseId,
        operatorId,
        action: "abandon_topic",
        // 放弃主题不涉及任何包，也不删 Release：三个列表都留空。
        packageNames: [],
        revisionBefore: release.revision,
        revisionAfter: release.revision,
        abandonedCrpReleaseIds: [],
        redispatchedPackageNames: [],
        abandonedTopicId: topicId,
        createdAt: abandonedAt,
      },
    });
  });

  return { releaseId, topicId, topicName: topic.name, abandonedAt };
}

/**
 * 读 CRP 上的主题名，给详情页的确认框用。
 *
 * 读不到就返回 `null`：这是页面上的辅助信息，不该因为 CRP 连不上就让整页打不开。
 * 还没建 Topic 的提测不必发请求。
 */
export async function loadCrpTopicName(
  topicId: string | null,
  network: BuildNetwork | undefined,
): Promise<string | null> {
  if (topicId === null) {
    return null;
  }

  try {
    return (await resolveReadClient(network).getTopic(Number(topicId))).name;
  } catch (error) {
    console.error(`[releases] 读 CRP 主题名失败（topic ${topicId}）`, error);

    return null;
  }
}

/** 只读请求用的客户端：不挂调用记录，也不改任何状态。 */
function resolveReadClient(network: BuildNetwork | undefined): CrpClient {
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
