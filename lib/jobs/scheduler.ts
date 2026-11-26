/**
 * 定时作业的调度骨架：三条作业的频率、咨询锁键，以及「抢锁 → 跑一轮 → 释放」这一段。
 *
 * 谁在用：`pnpm worker`（`scripts/worker.ts`）按这里给的频率循环调用 `runJobRound()`。
 * 这一层只管调度与抢占，作业本身一行没改 —— `runBaselineSync` / `runBuildDispatch` /
 * `runBuildPoll` 还是页面手动触发时调的那几个函数，没有第二份逻辑。
 *
 * 为什么锁要单独开一条连接：`pg_try_advisory_lock` 是**会话级**的，锁跟着那条连接走。
 * Prisma 的连接池是共享的，一次查询用完就还回池里，锁会跟着连接漂走 —— 所以每轮作业
 * 自己开一条连接，作业结束就关掉；连接一断，会话级锁自动释放。
 *
 * 为什么非要用咨询锁：后续要跑多副本。进程内的布尔标记、文件锁、启动时抢一次主，
 * 在多副本下全部失效，副本之间谁也不知道谁在跑。三个作业各用一把固定键，互不阻塞。
 */

/** 作业名。与 `.agents/spec/product/runtime.md` 第二节的频率表一一对应。 */
export type JobName = "baseline-sync" | "build-dispatch" | "build-poll";

/** 一条作业的固定参数。 */
export type JobSpec = {
  name: JobName;
  /** 两轮之间的间隔。 */
  intervalMs: number;
  /**
   * `pg_try_advisory_lock` 的固定键。
   *
   * 这是集群契约：所有副本必须用同一组键，三个作业必须互不相同。改键等于换一把锁，
   * 滚动升级期间新旧副本会各抢各的锁、同时跑同一个作业。
   */
  lockKey: number;
};

/** 三条作业：每小时、每 2 分钟、每 5 分钟；锁键互不相同。 */
export const JOB_SPECS: readonly JobSpec[] = [
  { name: "baseline-sync", intervalMs: 60 * 60 * 1000, lockKey: 7_310_001 },
  { name: "build-dispatch", intervalMs: 2 * 60 * 1000, lockKey: 7_310_002 },
  { name: "build-poll", intervalMs: 5 * 60 * 1000, lockKey: 7_310_003 },
];

/**
 * 一条专用数据库连接上的锁操作。
 *
 * 真实实现是 `lib/jobs/advisory-lock.ts`；测试注入假的，不碰数据库。
 */
export type LockConnection = {
  /** 抢锁：抢到返回 `true`，被别的会话占着返回 `false`。 */
  tryLock(lockKey: number): Promise<boolean>;
  /** 关连接。会话级咨询锁在会话结束时由 Postgres 释放。 */
  close(): Promise<void>;
};

/** 一轮的结局。 */
export type RoundResult = "success" | "failed" | "skipped";

export type RoundDeps = {
  /** 开一条专用连接，用来抢锁。 */
  openConnection: () => Promise<LockConnection>;
  /** 一条一条写日志，默认写 stdout；测试注入收集。 */
  log?: (line: string) => void;
  /** 取当前时间，默认真实时钟；测试固定住，日志里的时间与耗时才可断言。 */
  now?: () => Date;
};

/** 错误摘要：日志里只留人看得懂的一句，不写整段堆栈。 */
const ERROR_MESSAGE_LIMIT = 500;

const RESULT_LABELS: Record<RoundResult, string> = {
  success: "成功",
  failed: "失败",
  skipped: "跳过",
};

function errorSummary(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return message.slice(0, ERROR_MESSAGE_LIMIT);
}

/**
 * 关连接。失败只记一行、不向外抛：本轮作业已经跑完了，关连接失败不该把这一轮判成失败，
 * 更不能让 worker 进程退出。会话断了锁一样会释放，下一次重连不会卡住。
 */
async function closeQuietly(
  connection: LockConnection,
  log: (line: string) => void,
): Promise<void> {
  try {
    await connection.close();
  } catch (error) {
    log(`[worker] 关闭锁连接失败：${errorSummary(error)}`);
  }
}

/**
 * 跑一轮：抢锁 → 跑作业 → 关连接（释放锁）。
 *
 * 三条边界：
 *
 * 1. 抢不到锁就跳过这一轮，作业一次都不跑，也不排队等下一轮 —— 另一个副本已经在跑了。
 * 2. 单轮抛错只记日志，结局是 `failed`，下一轮照常抢锁。**这个函数不向外抛任何异常**，
 *    worker 进程因此不会因为一次失败退出。
 * 3. 连不上数据库、抢锁语句本身失败，同样只算这一轮失败。
 */
export async function runJobRound(
  spec: JobSpec,
  run: () => Promise<unknown>,
  deps: RoundDeps,
): Promise<RoundResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.info(line));
  const startedAt = now();

  function finish(result: RoundResult, reason?: string): RoundResult {
    const fields = [
      `[worker] 作业=${spec.name}`,
      `开始=${startedAt.toISOString()}`,
      `耗时=${Math.max(0, now().getTime() - startedAt.getTime())}ms`,
      `结果=${RESULT_LABELS[result]}`,
    ];

    if (reason !== undefined) {
      fields.push(`原因=${reason}`);
    }

    log(fields.join(" "));

    return result;
  }

  let connection: LockConnection;

  try {
    connection = await deps.openConnection();
  } catch (error) {
    // 连不上库：这一轮失败，下一轮重开连接。没有连接要关，所以不经过下面的 finally。
    return finish("failed", errorSummary(error));
  }

  let result: RoundResult = "success";
  let reason: string | undefined;

  try {
    if (!(await connection.tryLock(spec.lockKey))) {
      result = "skipped";
      reason = "被其他实例占用";
    } else {
      await run();
    }
  } catch (error) {
    result = "failed";
    reason = errorSummary(error);
  } finally {
    // 抢锁语句本身失败（权限、函数不存在、语句被取消）与作业抛错都走这里：连接一定要关。
    // 会话级咨询锁靠关连接释放，漏关就是每条失败路径泄漏一条数据库连接 ——
    // `build-dispatch` 每 2 分钟一轮，持续失败一天就能把 `max_connections` 耗光。
    await closeQuietly(connection, log);
  }

  return finish(result, reason);
}
