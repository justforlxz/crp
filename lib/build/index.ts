/**
 * `lib/build` 的公开出口。在 `lib/build` 之外只从这里 import。
 *
 * 后续节点需要的能力都在这张表里（A13 详情页、A14 构建队列）：
 *
 * | 能力 | 入口 |
 * | --- | --- |
 * | 往前推一步（建 Topic / 投递一个包 / 判定终局） | `advanceRelease` |
 * | 轮询构建结果并回写 | `pollReleaseBuilds` |
 * | 重投失败的构建任务 | `retryFailedTasks` |
 * | 取消整个提测 | `cancelRelease` |
 * | 看每个包的投递参数与 CRP Release ID | `loadReleaseDispatch` |
 * | 看这次投递发过哪些 CRP 请求 | `listCrpCallLogs` |
 * | 查一条提测属于哪个工作区（接口鉴权用） | `findReleaseScope` |
 * | 为一条提测建 CRP 调用记录器（其它模块自己调 CRP 时挂上） | `createCrpCallRecorder` |
 * | 定时轮询构建结果与工作流进度（A14） | `runBuildPoll` |
 * | 队列页 / 详情区块的只读数据 | `loadBuildQueue`、`loadReleaseBuildStatus` |
 * | 调度事件流水，含投递失败标记 | `recordPollEvent`、`listPollEvents`、`recordDispatchFailure`、`loadLatestDispatchFailures` |
 */

export {
  ACTIVE_RELEASE_STATES,
  advanceRelease,
  BuildError,
  cancelRelease,
  findReleaseScope,
  loadReleaseDispatch,
  pollReleaseBuilds,
  resolveActorUserId,
  resolveClients,
  retryFailedTasks,
  type AdvanceResult,
  type BuildOptions,
  type CancelResult,
  type BuildNetwork,
  type DispatchPackageView,
  type PollSummary,
  type ReleaseDispatchView,
  type ReleaseStateName,
  type RetryResult,
} from "./service";

export {
  createCrpCallRecorder,
  CRP_CALL_LOG_RETENTION_DAYS,
  listCrpCallLogs,
  pruneCrpCallLogs,
  type CrpCallLogRow,
  type CrpCallRecorder,
} from "./crpLog";

export {
  pickWorkflowProgress,
  runBuildPoll,
  WORKFLOW_PROGRESS_PENDING_MESSAGE,
  type BuildPollItem,
  type BuildPollOptions,
  type BuildPollSummary,
  type BuildPollTrigger,
  type WorkflowRaw,
} from "./poller";

export {
  POLL_EVENT_RETENTION_DAYS,
  listPollEvents,
  loadLatestDispatchFailures,
  prunePollEvents,
  recordDispatchFailure,
  recordPollEvent,
  type BuildPollEventInput,
  type BuildPollEventName,
  type BuildPollEventRow,
  type DispatchFailureKind,
  type DispatchFailureMarker,
} from "./pollEvent";

export {
  buildQueueView,
  formatDuration,
  loadBuildQueue,
  loadBuildQueueData,
  loadReleaseBuildStatus,
  type BuildArchView,
  type BuildQueueSnapshot,
  type BuildQueueStats,
  type BuildQueueView,
  type BuildStatusTaskView,
  type BuildStatusView,
  type LoadBuildQueueOptions,
  type QueueReleaseView,
  type QueueTaskRow,
} from "./queue";

export {
  buildStatusLabel,
  queueStageOf,
  releaseStatusLabel,
  snapshotStatusLabel,
  type QueueStage,
  type QueueStageInput,
  type StagePhase,
} from "./stage";
