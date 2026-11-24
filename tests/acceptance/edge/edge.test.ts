/**
 * 边界组（EDGE-01 ~ EDGE-10）。
 *
 * 边界用例的价值在「不该崩的地方真的没崩」：零软件包、单架构、超长文本、空工作区、依赖成环。
 * 需要 CRP / Shuttle/ 按人凭据才能造出来的几条留 TODO，原因写在各条里。
 *
 * `EDGE-05` 只验「九页都能打开、没有 500」；「空态长什么样」是界面组的 `UI-24`，
 * 两处各管一半，不重复。
 */

import "dotenv/config";

import { after, before } from "node:test";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { db, disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { mintSession, requestPath } from "../support/http";
import { expectContains, expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac98";

let fixture: Fixture | null = null;
let emptyProjectId = "";
let releaseId = "";

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  emptyProjectId = await fixture.project({ key: `${PREFIX}-empty`, name: `${PREFIX} 空项目` });

  const pkg = await fixture.package({ name: `${PREFIX}-kwin` });
  const project = await fixture.project({ key: `${PREFIX}-p`, name: `${PREFIX} 普通项目` });
  await fixture.addSoftware(project, pkg);
  releaseId = await fixture.release({
    projectId: project,
    version: `${PREFIX}-1.0.0`,
    snapshots: [{ packageName: `${PREFIX}-kwin` }],
  });
});

after(async () => {
  await fixture?.cleanup();
  await disconnect();
});

acceptanceWithEnv("EDGE-01", FIXTURE_ENV, async () => {
  const { loadReleaseProject } = await import("../../../lib/releases");

  const project = await loadReleaseProject(emptyProjectId);

  if (project === null) {
    throw new Error(`夹具里的空项目 ${emptyProjectId} 读不到`);
  }

  const codes = project.readiness.blockers.map((blocker) => blocker.code);

  expectEqual("EDGE-01", "零软件包项目命中的阻断条件", ["empty_software"], codes);
  expectTrue(
    "EDGE-01",
    "阻断原因写清了「项目还没有软件」以及去哪儿加",
    "message 里出现「软件清单」",
    (project.readiness.blockers[0]?.message ?? "").includes("软件清单"),
  );
  // 下一步禁用：页面按 `ready` 决定按钮可用性。
  expectEqual("EDGE-01", "零软件包项目能否进入下一步", false, project.readiness.ready);
});

acceptanceWithEnv("EDGE-02", FIXTURE_ENV, async () => {
  const { loadDashboard } = await import("../../../lib/stats");
  const prisma = await db();

  const singleArchProject = await fixture!.project({
    key: `${PREFIX}-arch`,
    name: `${PREFIX} 单架构项目`,
  });
  const archRelease = await fixture!.release({
    projectId: singleArchProject,
    version: `${PREFIX}-arch.0`,
    status: "building",
    snapshots: [{ packageName: `${PREFIX}-single`, status: "building" }],
  });

  const snapshot = await prisma.releasePackageSnapshot.findFirstOrThrow({
    where: { releaseId: archRelease },
    select: { id: true },
  });

  const task = await prisma.buildTask.create({
    data: {
      releaseId: archRelease,
      snapshotId: snapshot.id,
      status: "building",
      startedAt: new Date("2026-11-20T01:00:00Z"),
    },
    select: { id: true },
  });

  // 只有一个架构：分母为 1，不能出现除零（NaN / Infinity）。
  await prisma.buildJob.create({
    data: {
      buildTaskId: task.id,
      shuttleJobId: `${PREFIX}-job-1`,
      arch: "amd64",
      status: "success",
      startedAt: new Date("2026-11-20T01:00:00Z"),
      finishedAt: new Date("2026-11-20T01:05:00Z"),
    },
  });

  const view = await loadDashboard(fixture!.workspaceId);
  const row = view.queueTasks.find((item) => item.packageName === `${PREFIX}-single`);

  expectEqual("EDGE-02", "单架构包的进度文案", "1/1 个架构完成", row?.progress);
  expectEqual("EDGE-02", "单架构包的进度百分比", 100, row?.progressPercent);
});

acceptanceWithEnv("EDGE-03", FIXTURE_ENV, async () => {
  const { createRelease } = await import("../../../lib/releases");

  // 恰好 40 个字符：用例集里的「版本号 40 字符」。
  const longVersion = `${PREFIX}-`.padEnd(40, "9");
  const projectId = await fixture!.project({ key: `${PREFIX}-long`, name: `${PREFIX} 长版本项目` });
  const pkg = await fixture!.package({ name: `${PREFIX}-long-pkg` });
  await fixture!.addSoftware(projectId, pkg);

  const created = await createRelease(
    {
      projectId,
      version: longVersion,
      description: null,
      packages: [
        {
          packageName: `${PREFIX}-long-pkg`,
          branch: "develop/eagle",
          commitSha: "a".repeat(40),
          customTag: null,
        },
      ],
    },
    { createdById: fixture!.userId, reader: { readCodeVersion: () => Promise.resolve("1.0.0-1") } },
  );

  expectEqual("EDGE-03", "40 字符版本号的长度", 40, created.version.length);
  expectEqual("EDGE-03", "40 字符版本号原样保存", longVersion, created.version);
});

acceptanceWithEnv("EDGE-04", FIXTURE_ENV, async () => {
  const { loadReleaseDetail } = await import("../../../lib/releases");

  // 恰好 200 个字：用例集里的「提交说明 200 字符」。
  const longSummary = `提交说明${"很长".repeat(98)}`;

  const detail = await loadReleaseDetail(releaseId, {
    readCommitInfo: () => Promise.resolve({ summary: longSummary, authorName: "验收" }),
  });

  expectEqual(
    "EDGE-04",
    "详情里提交说明的长度（不截断）",
    200,
    detail.packages[0]?.commitMessage?.length,
  );
  expectEqual("EDGE-04", "详情里提交说明的原文", longSummary, detail.packages[0]?.commitMessage);
});

acceptanceWithEnv("EDGE-05", ["database", "baseUrl"], async () => {
  const { baseUrl } = await import("../support/env");
  const session = await mintSession({ workspaceSlug: `${PREFIX}-ws` });

  try {
    const pages = [
      "/dashboard",
      "/releases",
      `/releases/${releaseId}`,
      "/releases/new",
      "/projects",
      "/managers",
      "/packages",
      "/baselines",
      "/webhooks",
    ];
    const bad: string[] = [];

    for (const path of pages) {
      const response = await requestPath(baseUrl() ?? "", path, { cookie: session.cookie });

      if (response.status !== 200) {
        bad.push(`${path} → HTTP ${String(response.status)}`);
      }
    }

    expectEqual("EDGE-05", "九页返回非 200 的情况", [], bad);
  } finally {
    await session.cleanup();
  }
});

acceptanceTodo(
  "EDGE-06",
  "「CRP 401 时提示凭据失效并指向「我的账号」」需要按人存放的凭据与 /settings/credentials 页面，这两样都在 MKACG-986 里",
);

acceptanceTodo(
  "EDGE-07",
  "「CRP 429 判为限流并重试、不判业务失败」要用真实的 429 响应驱动投递；`tests/build-dispatch.test.ts` 用 `CrpRateLimitedError` 覆盖了这条判定，验收环境缺 CRP 沙箱",
);

acceptanceTodo(
  "EDGE-08",
  "「某个架构失败 → 提测变有失败、失败包可见、下游不动」要走完整构建回写链路，需要 CRP / Shuttle 沙箱；`tests/build-dispatch.test.ts` 覆盖了同一分支",
);

acceptanceTodo(
  "EDGE-09",
  "「提测创建后删掉创建者凭据 → 该提测显示构建状态停更、其它提测不受影响」依赖 MKACG-986 的按人凭据与停更原因字段，当前 main 上还没有",
);

acceptanceWithEnv("EDGE-10", FIXTURE_ENV, async () => {
  const [{ loadReleaseProject }, { saveDependencies }] = await Promise.all([
    import("../../../lib/releases"),
    import("../../../lib/packages"),
  ]);

  const projectId = await fixture!.project({ key: `${PREFIX}-cycle`, name: `${PREFIX} 成环项目` });
  const nameA = `${PREFIX}-cycle-a`;
  const nameB = `${PREFIX}-cycle-b`;
  const a = await fixture!.package({ name: nameA });
  const b = await fixture!.package({ name: nameB });

  await fixture!.addSoftware(projectId, a);
  await fixture!.addSoftware(projectId, b);
  // 绕过应用层校验直接写出一组互相依赖，模拟「库里已经有环」。
  await fixture!.dependencies(a, [b]);
  await fixture!.dependencies(b, [a]);

  const project = await loadReleaseProject(projectId);

  if (project === null) {
    throw new Error(`夹具里的成环项目 ${projectId} 读不到`);
  }

  const cycle = project.readiness.blockers.find((blocker) => blocker.code === "dependency_cycle");

  expectTrue(
    "EDGE-10",
    "清单里已有的环被识别为 dependency_cycle",
    "阻断条件里出现 dependency_cycle",
    cycle !== undefined,
  );
  expectEqual("EDGE-10", "有环时不能提交", false, project.readiness.ready);

  // 保存入口必须拒收，且拒绝之后不能留下半条依赖。
  // 另起一对干净的包：x 的上游是 y，再让 y 依赖 x 就成环。
  const x = await fixture!.package({ name: `${PREFIX}-save-x` });
  const y = await fixture!.package({ name: `${PREFIX}-save-y` });
  await fixture!.dependencies(x, [y]);

  let message = "";

  try {
    await saveDependencies(y, [x]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expectContains("EDGE-10", "保存成环依赖时拒绝并说明是成环", "成环", message);

  const prisma = await db();
  const upstreams = await prisma.packageDependency.findMany({
    where: { packageId: y },
    select: { upstreamPackageId: true },
  });

  expectEqual("EDGE-10", "被拒绝后 y 的上游依赖条数", 0, upstreams.length);
});
