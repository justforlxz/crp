/**
 * 投递与轮询用谁的凭据（MKACG-986 / CRED-5）。
 *
 * 契约第六节把调用身份分成两种：
 *
 * | 场景 | 用谁的身份 |
 * | --- | --- |
 * | 页面操作、前台接口 | 当前登录用户 |
 * | 后台作业（build-dispatch / build-poll） | 该提测的创建者 |
 *
 * 后台作业没有登录会话，所以「没传就是创建者」这条默认值必须锁住：写反了会让所有定时任务
 * 以同一个人的名义调 CRP，审计链又断一次，而且那个人删了凭据全平台停更。
 *
 * 另外锁住「注入网络时不读凭据」：单测与 e2e 用假网络跑完整链路，不该被要求先配一份凭据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { BuildError, resolveActorUserId, resolveClients } from "../lib/build";
import { prisma } from "../lib/db";

const PREFIX = "zzactor";

type Fixture = {
  releaseId: string;
  creatorId: string;
  otherId: string;
};

let fixture: Fixture;

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((item) => item.id);

  await prisma.release.deleteMany({ where: { project: { key: { startsWith: PREFIX } } } });
  await prisma.project.deleteMany({ where: { key: { startsWith: PREFIX } } });
  await prisma.projectManager.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.baseline.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.workspace.deleteMany({ where: { slug: { startsWith: PREFIX } } });

  if (ids.length > 0) {
    await prisma.userCredential.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function createUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${suffix}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} ${suffix}`,
    },
    select: { id: true },
  });

  return user.id;
}

before(async () => {
  await cleanup();

  const creatorId = await createUser("creator");
  const otherId = await createUser("other");

  const workspace = await prisma.workspace.create({
    data: { slug: `${PREFIX}-workspace`, name: `${PREFIX} 工作区` },
    select: { id: true },
  });
  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: `${PREFIX}-manager` },
    select: { id: true },
  });
  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: `${PREFIX}-branch`,
      name: `${PREFIX}-baseline`,
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: `${PREFIX}-proj`,
      name: `${PREFIX} 项目`,
    },
    select: { id: true },
  });
  const release = await prisma.release.create({
    data: {
      projectId: project.id,
      version: "1.0.0",
      createdById: creatorId,
      status: "pending",
    },
    select: { id: true },
  });

  fixture = { releaseId: release.id, creatorId, otherId };
});

after(async () => {
  await cleanup();
});

test("后台作业没传调用身份时，用这条提测的创建者（CRED-5）", async () => {
  assert.equal(await resolveActorUserId(fixture.releaseId, {}), fixture.creatorId);
});

test("前台显式传当前登录用户时用它，即使他不是创建者", async () => {
  assert.equal(
    await resolveActorUserId(fixture.releaseId, { actorUserId: fixture.otherId }),
    fixture.otherId,
  );
});

test("提测不存在时抛 404，而不是拿一个空身份去调 CRP", async () => {
  await assert.rejects(
    () => resolveActorUserId("00000000-0000-4000-8000-000000000986", {}),
    (error: unknown) => {
      assert.ok(error instanceof BuildError);
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test("注入网络时不读凭据：没配凭据也能建出客户端", async () => {
  // 这两个账号都没配凭据；注入网络之后不该去查库。
  const resolved = await resolveClients(fixture.releaseId, {
    network: { crpFetch: (async () => new Response("{}")) as unknown as typeof fetch },
  });

  assert.equal(typeof resolved.clients.crp.createTopic, "function");
  assert.equal(typeof resolved.clients.shuttle.listBuildTasks, "function");
});
