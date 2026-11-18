/**
 * Shuttle 客户端验证脚本。
 *
 * 用法：
 *
 * ```bash
 * pnpm tsx scripts/verify-shuttle.ts               # 两个基线各查一次，并用最近一次构建验构建任务
 * pnpm tsx scripts/verify-shuttle.ts 599971 600127 # 指定 CRP 的 Release 里拿到的构建 ID
 * ```
 *
 * 只做读取，不触发构建、不重试任务。
 */

import { createShuttleClient, readShuttleEnv } from "../lib/integrations/shuttle";

/** 需求里指定的两个测试基线。 */
const BASELINES = ["eagle-1071", "snipe-2500u2"];

/** 每次至少查回这么多个软件包才算验证通过。 */
const MIN_EXPECTED_PACKAGES = 10;

/** 额外打印这几个软件包，便于和 Shuttle 页面上的版本人工对照。 */
const SPOTLIGHT_PACKAGES = ["kwin", "wayland", "dde-dock"];

async function main(): Promise<void> {
  const env = readShuttleEnv();
  const client = createShuttleClient(env);

  console.log(`Shuttle 地址：${env.baseUrl}`);

  let packageFailures = 0;

  for (const baseline of BASELINES) {
    const startedAt = performance.now();
    const packages = await client.listBaselinePackages(baseline);
    const elapsed = Math.round(performance.now() - startedAt);

    console.log(`\n=== 基线 ${baseline} ===`);
    console.log(`软件包数量：${packages.length}，耗时 ${elapsed}ms`);

    if (packages.length < MIN_EXPECTED_PACKAGES) {
      packageFailures += 1;
      console.log(`结论：不通过，少于 ${MIN_EXPECTED_PACKAGES} 个软件包`);
    } else {
      console.log(`结论：通过（不少于 ${MIN_EXPECTED_PACKAGES} 个）`);
    }

    console.log("前 10 个软件包：");
    for (const item of packages.slice(0, 10)) {
      console.log(`  ${item.name} ${item.version}`);
    }

    console.log("对照软件包：");
    for (const name of SPOTLIGHT_PACKAGES) {
      const found = packages.find((item) => item.name === name);
      console.log(`  ${name} ${found ? found.version : "（该基线仓库里没有）"}`);
    }
  }

  const buildIds = process.argv.slice(2);
  let buildId: string;

  if (buildIds.length > 0) {
    buildId = buildIds[0];
  } else {
    const newest = await client.listBuildTasks(undefined, { pageSize: 1 });
    const task = newest.tasks[0];

    if (!task) {
      throw new Error("Shuttle 没有返回任何构建任务，无法验证构建任务查询");
    }

    buildId = String(task.key);
    console.log(`\n未指定构建 ID，改用 Shuttle 最近一次构建：${buildId}`);
  }

  console.log(`\n=== 构建任务 ${buildId} ===`);

  const page = await client.listBuildTasks(buildId);
  const task = page.tasks[0];

  if (!task) {
    throw new Error(`构建 ${buildId} 没有查回任何任务`);
  }

  console.log(
    `任务：key=${task.key} 软件包=${task.pkgname} 版本=${task.pkgver} 状态=${task.status} 仓库=${task.reponame}`,
  );
  console.log(`作业数：${task.jobs.length}`);

  for (const job of task.jobs) {
    console.log(`  作业 ${job.id} 架构 ${job.arch} 状态 ${job.status}`);
  }

  const firstJob = task.jobs[0];

  if (!firstJob) {
    console.log("该任务没有作业，跳过构建日志验证");
    process.exit(packageFailures === 0 ? 0 : 1);
  }

  const log = await client.getJobLog(firstJob.id);
  const preview = log.log.slice(0, 200).replace(/\r?\n/g, " | ");

  console.log(`\n作业 ${log.jobId} 日志长度：${log.log.length}`);
  console.log(`日志开头：${preview}`);

  process.exit(packageFailures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("验证失败：", error);
  process.exit(1);
});
