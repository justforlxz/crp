/**
 * 「取消提测」（MKACG-954）：把平台自己创建的提测连同它投出去的 Release 一起清理掉。
 *
 * 删除能力本来就在 `lib/build` 的 `cancelRelease` 里：逐个删掉 Topic 下的 Release、把 Topic
 * 标记为已放弃，最后把本地状态置 `abandoned`。这里补的是两件外围的事，不重写删除逻辑（MUST）：
 *
 * 1. **入口的判定**（`cancelReleaseLockReason`）：页面用它决定按钮禁用与提示文案，服务端用
 *    同一个纯函数拒绝 —— 页面不会说「能取消」而动作被拒。
 * 2. **服务端的拒绝**（`cancelPlatformRelease`）：取消不可撤销，只在真的能取消时才往下走，
 *    判定看完再原样交给 `cancelRelease`。
 *
 * 两条硬约束：
 *
 * - **只对平台创建的提测生效**（MUST NOT 反向）：从 CRP 导入的主题里 Release 是别人投的，
 *   只能走「放弃提测主题」（那里一条 Release 都不删）。页面不显示这个入口，服务端也拒绝。
 * - **未转测才能取消**（MUST）：以服务端现读的 `WorkProgress` 为准，`>= 20` 直接拒绝；
 *   读不到进度同样拒绝，不默认放行。页面上的禁用只是提示。
 */

import {
  cancelRelease,
  createCrpCallRecorder,
  type BuildNetwork,
  type CancelResult,
} from "../build";
import { prisma } from "../db";
import {
  createCrpClient,
  createCrpClientFromEnv,
  CRP_DEFAULT_BASE_URL,
  WORK_PROGRESS,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  workProgressLabel,
  type CrpClient,
} from "../integrations/crp";
import { ReleaseError } from "./service";

/** 导入的提测不提供「取消提测」，原因只有一句，页面与接口共用。 */
const IMPORTED_SOURCE_MESSAGE =
  "这条提测是从 CRP 导入的：导入主题里的 Release 是别人投的，不能删。"
  + "导入的提测走「放弃提测主题」，那个动作一条 Release 都不删。";

/** 判定「取消提测」要用到的提测字段，取自详情页已经读到的数据。 */
export type CancelReleaseLockInput = {
  /** `platform` 或 `imported`。 */
  source: string;
  status: string;
  /** 现读到的 CRP 工作流进度；读不到为 `null`。 */
  workProgress: number | null;
  workProgressLabel: string | null;
};

/**
 * 「取消提测」现在能不能做；不能做时给出给人看的原因。
 *
 * 页面用它决定按钮禁用与提示，`cancelPlatformRelease` 用它拒绝。判定顺序与
 * `cancelPlatformRelease` 的拒绝顺序一致，两处不会各说一套。
 *
 * 它只是提示：真正能不能取消由服务端现读工作流进度后再定一次。
 */
export function cancelReleaseLockReason(input: CancelReleaseLockInput): string | null {
  // 按来源分流：两个动作互斥，导入的这条不给「取消提测」的入口。
  if (input.source !== "platform") {
    return IMPORTED_SOURCE_MESSAGE;
  }

  if (input.status === "abandoned") {
    return "这条提测已经取消过了，不能重复取消。";
  }

  if (input.workProgress === null) {
    return "读不到 CRP 的工作流进度，无法判断这条提测是否已经转测，取消会被拒绝。";
  }

  if (input.workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST) {
    return (
      `这条提测已经转测（CRP 工作流进度 ${input.workProgress}：` +
      `${input.workProgressLabel ?? "未知状态"}），转测之后不能再取消。`
    );
  }

  return null;
}

/**
 * 取消会删掉几条 Release。
 *
 * 口径与 `cancelRelease` 的循环一致：只数**当前轮**里已经有 CRP Release 的包。
 * 被换包替换掉的历史轮不数，它们的 Release 在换包时就已经删掉了。
 * 确认框要写「会逐个删除 N 条 Release」，N 取这个数。
 */
export async function loadCancelableReleaseCount(releaseId: string): Promise<number> {
  return prisma.releasePackageSnapshot.count({
    where: { releaseId, supersededById: null, repositoryRecord: { isNot: null } },
  });
}

/** 取消只需要从 CRP 读工作流进度；删除与放弃仍由 `cancelRelease` 自己发。 */
type CancelCrpApis = Pick<CrpClient, "getTopicWorkflow">;

/** 建 CRP 客户端，并把调用记录挂到请求层上；写法与 `lib/releases/abandon.ts` 的同名函数一致。 */
function resolveCrp(releaseId: string, network: BuildNetwork | undefined): CancelCrpApis {
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

export type CancelReleaseOptions = {
  /** 注入用：单测换掉 CRP 的网络层，其余代码照旧。 */
  network?: BuildNetwork;
};

/**
 * 现读 CRP 的工作流进度。
 *
 * MUST：判断能不能取消以服务端现读到的 `WorkProgress` 为准，不认库里的旧值。
 * 读不到就抛错（网络错误与认证失败都算「读不到」），由调用方拒绝这次取消。
 * 还没建 Topic 的提测没有任何 CRP 内容可删，按「未开始」处理。
 */
async function readWorkProgress(
  releaseId: string,
  topicId: string | null,
  network: BuildNetwork | undefined,
): Promise<{ workProgress: number; workProgressLabel: string }> {
  if (topicId === null) {
    return {
      workProgress: WORK_PROGRESS.notStarted,
      workProgressLabel: workProgressLabel(WORK_PROGRESS.notStarted),
    };
  }

  try {
    const workflow = await resolveCrp(releaseId, network).getTopicWorkflow(Number(topicId));

    return { workProgress: workflow.workProgress, workProgressLabel: workflow.workProgressLabel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[releases] 取消提测前读 CRP 工作流进度失败（topic ${topicId}）`, error);
    throw new ReleaseError(
      `读不到 CRP 的工作流进度（${message}），无法判断这条提测是否已经转测，这次取消没有执行。`,
      502,
    );
  }
}

/**
 * 复检之后取消一条平台创建的提测。
 *
 * 顺序：读库里这条提测 → 判来源与状态 → 现读 CRP 工作流进度 → `cancelRelease`。
 * 前四步任一不满足就抛出，一个 CRP 写请求都不发；通过之后删除与放弃全交给 `cancelRelease`。
 *
 * 失败明细原样交回调用方：取消是逐个删的，可能只做成一部分，调用方必须把它们显示出来。
 * 本地状态由 `cancelRelease` 写，这里不改它。
 */
export async function cancelPlatformRelease(
  releaseId: string,
  options: CancelReleaseOptions = {},
): Promise<CancelResult> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { source: true, status: true, crpTopicId: true },
  });

  if (release === null) {
    throw new ReleaseError("提测记录不存在。", 404);
  }

  // MUST NOT：导入的主题里 Release 是别人投的，连接口这一层也拒绝。
  if (release.source !== "platform") {
    throw new ReleaseError(IMPORTED_SOURCE_MESSAGE, 409);
  }

  if (release.status === "abandoned") {
    throw new ReleaseError("这条提测已经取消过了，不能重复取消。", 409);
  }

  const progress = await readWorkProgress(releaseId, release.crpTopicId, options.network);
  const lockReason = cancelReleaseLockReason({
    source: release.source,
    status: release.status,
    workProgress: progress.workProgress,
    workProgressLabel: progress.workProgressLabel,
  });

  if (lockReason !== null) {
    throw new ReleaseError(lockReason, 409);
  }

  return cancelRelease(releaseId, { network: options.network });
}
