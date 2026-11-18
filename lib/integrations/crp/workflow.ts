/**
 * CRP Topic 的工作流进度（WorkProgress）。
 *
 * A17 判断「提测还能不能改包」的唯一依据就是这里的数值：`WorkProgress >= 20` 表示已转测，
 * 此时 CRP 不允许再往该 Topic 里补包或换包。所以对调用方只暴露数字，不等同于中文标签。
 *
 * 标签取自 CRP 工作流的状态名。其中 `0 未开始` 在真实响应里观察到了
 * （新建 Topic 的 workflow/info 返回 `WorkProgress: 0`），其余取值来自 CRP 页面文案，
 * 本节点没有逐个跑过去验证，见 FINDINGS.md。
 */

import type { CrpRawWorkflowInfo, CrpTopicWorkflow } from "./types";

export const WORK_PROGRESS = {
  notStarted: 0,
  updating: 10,
  updatingRejectedByTest: 13,
  transferringToTest: 20,
  testFormUploaded: 22,
  testManagerAssigned: 25,
  testing: 40,
  transferredToRelease: 52,
  releaseManagerAssigned: 60,
  done: 100,
} as const;

/**
 * 已转测的分界线。
 *
 * 到达这个值之后，CRP 侧不再接受往这个 Topic 里投递或替换包。
 */
export const WORK_PROGRESS_TRANSFERRED_TO_TEST = WORK_PROGRESS.transferringToTest;

const WORK_PROGRESS_LABELS: Record<number, string> = {
  [WORK_PROGRESS.notStarted]: "未开始",
  [WORK_PROGRESS.updating]: "更新",
  [WORK_PROGRESS.updatingRejectedByTest]: "更新且被测试打回",
  [WORK_PROGRESS.transferringToTest]: "转测试中（无法更新包）",
  [WORK_PROGRESS.testFormUploaded]: "转测试中（已上传转测申请单）",
  [WORK_PROGRESS.testManagerAssigned]: "转测试中（已指派测试管理员）",
  [WORK_PROGRESS.testing]: "正在测试（研发无权操作）",
  [WORK_PROGRESS.transferredToRelease]: "转发布成功（尚未指派发布管理员）",
  [WORK_PROGRESS.releaseManagerAssigned]: "转发布成功",
  [WORK_PROGRESS.done]: "完成",
};

const UNKNOWN_LABEL = "未知状态";

/** 拿进度对应的中文标签；没见过的取值返回「未知状态」。 */
export function workProgressLabel(workProgress: number): string {
  return WORK_PROGRESS_LABELS[workProgress] ?? UNKNOWN_LABEL;
}

/**
 * 把 workflow/info 的响应整理成调用方要的结构。
 *
 * 注意 `TopicID`：新建的 Topic 还没走过工作流时，CRP 返回的是全零对象
 * (`TopicID: 0`, `WorkProgress: 0`)，而不是 404。这里用请求时传的 topicId 兜底，
 * 免得调用方拿到一个主题 ID 为 0 的结果。
 */
export function normalizeTopicWorkflow(
  topicId: number,
  raw: CrpRawWorkflowInfo,
): CrpTopicWorkflow {
  const value = Number(raw.WorkProgress);
  const workProgress = Number.isFinite(value) ? value : WORK_PROGRESS.notStarted;
  const rawTopicId = Number(raw.TopicID);

  return {
    topicId: Number.isFinite(rawTopicId) && rawTopicId > 0 ? rawTopicId : topicId,
    workProgress,
    workProgressLabel: workProgressLabel(workProgress),
    appointUser: raw.AppointUser ?? "",
    testTableUrl: raw.TestTableUrl ?? "",
    releaseTableUrl: raw.ReleaseTableUrl ?? "",
    raw,
  };
}
