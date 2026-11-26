/**
 * 咨询锁的真实实现：自己开一条 `pg.Client`，抢到锁后由调用方持有到作业结束。
 *
 * 为什么不复用 `lib/db.ts` 的 Prisma 客户端：池里的连接是共享的，一次查询用完就还回去，
 * 会话级锁会跟着那条连接漂走 —— 锁必须在同一条连接上持有到作业结束，所以这里单独开一条，
 * 用完就关，关掉的时候 Postgres 自己释放锁。
 */

import { Client } from "pg";

import { readEnv } from "../env";
import type { LockConnection } from "./scheduler";

/**
 * 锁连接的 `application_name`。
 *
 * 固定一个名字，`pg_stat_activity` 里一眼能分出 worker 的锁连接，排障时不用猜是谁占着库；
 * 运维要掐断它们时也能按名字挑，不必按 pid 猜。
 */
export const ADVISORY_LOCK_APPLICATION_NAME = "crp-worker";

/**
 * 建连接的超时。
 *
 * 不设的话，地址不可达但只丢包（不是拒绝连接）时会等操作系统的 TCP 超时，动辄几分钟；
 * 那段时间这条作业的循环进不了下一轮，日志里也看不出「连不上库」。10 秒足够内网建连。
 */
export const ADVISORY_LOCK_CONNECT_TIMEOUT_MS = 10_000;

const ERROR_MESSAGE_LIMIT = 500;

/** 错误摘要：日志里只留人看得懂的一句，不写整段堆栈。 */
function errorSummary(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return message.slice(0, ERROR_MESSAGE_LIMIT);
}

export type AdvisoryLockOptions = {
  /** 连接出错时写一行日志，默认写 stderr；测试注入收集。 */
  log?: (line: string) => void;
};

export async function openAdvisoryLockConnection(
  source: Record<string, string | undefined> = process.env,
  options: AdvisoryLockOptions = {},
): Promise<LockConnection> {
  const log = options.log ?? ((line: string) => console.error(line));

  const client = new Client({
    connectionString: readEnv(source).DATABASE_URL,
    application_name: ADVISORY_LOCK_APPLICATION_NAME,
    connectionTimeoutMillis: ADVISORY_LOCK_CONNECT_TIMEOUT_MS,
  });

  await client.connect();

  // 持有锁期间连接被对端断开（Postgres 重启、主备切换、`pg_terminate_backend`、云主机
  // 回收空闲连接）时，pg 会 emit 一个 `error` 事件。没有监听器的话 Node 把它当未捕获
  // 异常，整个 worker 进程退出，三条作业一起停 —— 正是本单要修掉的那类故障。
  //
  // 这里只记日志、不向外抛：连接已经不可用，后续语句自己会抛错，这一轮就走
  // `runJobRound()` 的「本轮失败」路径，下一轮重新开一条连接。注册放在 `connect()`
  // 之后，是为了让「连不上库」只由 `connect()` 的失败报一次，不重复记两行。
  client.on("error", (error: Error) => {
    log(`[worker] 锁连接出错：${errorSummary(error)}`);
  });

  return {
    async tryLock(lockKey: number): Promise<boolean> {
      // 显式标 `::bigint`：不标的话参数按文本类型推断，`pg_try_advisory_lock` 会挑到
      // 需要两个 int4 的另一个重载，直接报「函数不存在」。
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as locked",
        [lockKey],
      );

      return result.rows[0]?.locked === true;
    },

    async close(): Promise<void> {
      await client.end();
    },
  };
}
