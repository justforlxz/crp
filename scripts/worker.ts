/**
 * 常驻调度进程：在一个进程里按固定频率跑三条作业。
 *
 * 启动命令 `pnpm worker`。与 web 同一份代码、同一个镜像，只是启动命令不同：worker 不监听端口，
 * 也不加载页面，只连数据库与 CRP / Shuttle / Gerrit。
 *
 * 作业在进程内直接调用库里已有的函数（`runBaselineSync` / `runBuildDispatch` / `runBuildPoll`），
 * **不走 HTTP** —— 不走自己请求自己，也不指望 web 进程活着。三个 HTTP 接口保留下来，
 * 只给手动触发与排障用；删掉它们也不影响这里的调度。
 *
 * 集群安全与失败隔离都在 `lib/jobs/scheduler.ts`：每轮先抢咨询锁，抢不到就跳过；
 * 单轮失败只记日志，进程不退出。
 */

import "dotenv/config";

import { runBuildPoll } from "../lib/build";
import { openAdvisoryLockConnection } from "../lib/jobs/advisory-lock";
import { runBaselineSync } from "../lib/jobs/baseline-sync";
import { runBuildDispatch } from "../lib/jobs/build-dispatch";
import {
  JOB_SPECS,
  runJobRound,
  type JobName,
  type JobSpec,
} from "../lib/jobs/scheduler";

/** 作业名到实际函数的映射。表里少一条，`Record<JobName, …>` 会直接编译不过。 */
const JOBS: Record<JobName, () => Promise<unknown>> = {
  "baseline-sync": () => runBaselineSync({ trigger: "schedule" }),
  "build-dispatch": () => runBuildDispatch({ trigger: "schedule" }),
  "build-poll": () => runBuildPoll({ trigger: "schedule" }),
};

function formatInterval(intervalMs: number): string {
  const minutes = intervalMs / 60_000;

  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function delay(intervalMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, intervalMs));
}

/**
 * 一条作业的主循环：跑完一轮再等下一轮。
 *
 * 用「跑完再等」而不是 `setInterval`：一轮跑超时的时候不会叠第二轮。叠起来的那一轮本来也会被
 * 咨询锁挡掉（自己这条连接还持有锁），但日志会写成「被其他实例占用」—— 同一进程自己等自己，
 * 这条日志是假的，排障时会查错方向。
 */
async function loop(spec: JobSpec): Promise<never> {
  for (;;) {
    await runJobRound(spec, JOBS[spec.name], {
      openConnection: () => openAdvisoryLockConnection(),
    });

    await delay(spec.intervalMs);
  }
}

function shutdown(signal: NodeJS.Signals): void {
  // 不排队等在跑的作业：每一轮都是「一条提测往前一步」或「一次全量同步」，都可重入，
  // 下一轮或重启后接着跑。进程一退，锁连接断开，咨询锁由 Postgres 释放。
  console.info(`[worker] 退出 pid=${process.pid} 信号=${signal}`);
  process.exit(0);
}

function main(): void {
  console.info(
    `[worker] 启动 pid=${process.pid} ` +
      JOB_SPECS.map(
        (spec) => `${spec.name}=每 ${formatInterval(spec.intervalMs)}（锁键 ${spec.lockKey}）`,
      ).join(" "),
  );

  for (const spec of JOB_SPECS) {
    // `runJobRound()` 按约定不抛异常，`delay()` 也不会，所以这条 catch 正常永远不执行。
    // 留着它是因为「日志写不出去」这类意外（stdout 被关掉时 `console.info` 会抛 EPIPE）
    // 会以未捕获 rejection 的形式在 Node 22 上结束整个进程 —— 那正是本单要避免的形态。
    loop(spec).catch((error: unknown) => {
      console.error(
        `[worker] 作业 ${spec.name} 的调度循环意外退出：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main();
