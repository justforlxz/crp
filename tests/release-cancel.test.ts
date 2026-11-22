/**
 * 「取消提测」（MKACG-954）的集成测试：连真数据库，只有 CRP 那一层换成假的。
 *
 * 走的是生产代码的完整链路：`cancelPlatformRelease` → 判来源与状态 → 现读 CRP 工作流
 * → `cancelRelease`（逐个删 Release + 放弃 Topic）→ 回写本地状态。页面动作与
 * `POST /api/releases/{id}/dispatch?action=cancel` 走的是同一段判定，所以也一并锁在
 * 这个文件里（`cancelReleaseResponse`：鉴权在 `POST` 里做，测试进程拿不到 Next 的请求
 * 上下文，命中不了 `cookies()`）。
 *
 * 锁住本节点的验收标准：
 *
 * - AC1/AC3：平台创建、未转测的提测可以取消，CRP 侧逐个删 Release 并放弃 Topic，
 *   本地状态与快照都置 `abandoned`；
 * - AC4：已转测（`WorkProgress >= 20`）时页面动作与服务端入口都拒绝，且一个删除请求都不发；
 *   读不到工作流进度同样拒绝，不默认放行；
 * - 按来源互斥：导入的提测不能取消（那是「放弃提测主题」的事），页面动作与接口都拒绝且不发请求；
 * - MUST：删除失败时不吞明细，`failures` 原样交回调用方；删除有失败时不放弃 Topic。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { cancelReleaseResponse } from "../app/api/releases/[id]/dispatch/route";
import { prisma } from "../lib/db";
import {
  cancelPlatformRelease,
  cancelReleaseLockReason,
  loadCancelableReleaseCount,
  ReleaseError,
} from "../lib/releases";

const PREFIX = "zza22";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
const PROJECT_KEY = `${PREFIX}-proj`;
const CRP_BRANCH_ID = "8860960";
const CRP_BASE = "https://crp.example.test/api";
const CRP_TOKEN = "test-token";

const TOPIC_NAME = `${PROJECT_KEY}-2.0.0`;

function pkg(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

/** 假 CRP 的状态：响应形态按 `lib/integrations/crp/FINDINGS.md` 里实测的那几条写。 */
type FakeCrp = {
  /** 主题对象；`PUT` 成功后 `Abandoned` 置真，供「复查」用。 */
  topic: Record<string, unknown>;
  /** 按顺序记下每一次请求，用来验「先读进度再删」与「拒绝时一个请求都不发」。 */
  received: string[];
  /** 这些 Release ID 删除时回 500，用来验失败明细。 */
  failDelete: Set<number>;
  /** 这些 Release ID 删除时回 404，用来验「CRP 上已经没有」按删成功处理。 */
  notFoundDelete: Set<number>;
  /** `GET /topics/{id}/workflow/info` 返回的进度。 */
  workProgress: number;
  /** 让工作流接口报错，验「读不到就拒绝」。 */
  workflowFails: boolean;
};

function newFakeCrp(): FakeCrp {
  return {
    topic: {
      Name: TOPIC_NAME,
      NameB64: Buffer.from(TOPIC_NAME, "utf8").toString("base64"),
      BranchID: Number(CRP_BRANCH_ID),
      Type: "test",
      RepoType: "deb",
      State: 5,
      Abandoned: false,
      Completed: false,
      Owner: [{ employeeid: "1", name: "crp-user", namecn: "CRP 用户" }],
      Members: null,
    },
    received: [],
    failDelete: new Set<number>(),
    notFoundDelete: new Set<number>(),
    workProgress: 10,
    workflowFails: false,
  };
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  return new URL(url).pathname.replace(/^\/api/, "");
}

function crpFetchOf(state: FakeCrp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    state.received.push(`${method} ${path}`);

    const workflow = /^\/topics\/(\d+)\/workflow\/info$/.exec(path);

    if (method === "GET" && workflow !== null) {
      if (state.workflowFails) {
        // 带 message 的响应是 CRP 的明确拒绝，请求层不会重试，测试跑得快。
        return json(JSON.stringify({ message: "workflow unavailable" }), 500);
      }

      return json(
        JSON.stringify({ TopicID: Number(workflow[1]), WorkProgress: state.workProgress }),
      );
    }

    const deleteRelease = /^\/topic_releases\/(\d+)$/.exec(path);

    if (method === "DELETE" && deleteRelease !== null) {
      const releaseId = Number(deleteRelease[1]);

      if (state.failDelete.has(releaseId)) {
        return json(JSON.stringify({ message: "delete release failed" }), 500);
      }

      if (state.notFoundDelete.has(releaseId)) {
        return json(JSON.stringify({ message: "release not found" }), 404);
      }

      return json(JSON.stringify({ code: "http.StatusOK", status: "success" }));
    }

    const topic = /^\/topics\/(\d+)$/.exec(path);

    if (method === "GET" && topic !== null) {
      return json(JSON.stringify({ ...state.topic, ID: Number(topic[1]) }));
    }

    if (method === "PUT" && topic !== null) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      state.topic = { ...state.topic, Abandoned: body.Abandoned === true };

      return json(JSON.stringify({ ...state.topic, ID: Number(topic[1]) }));
    }

    return json(JSON.stringify({ message: `测试没有实现 ${method} ${path}` }), 404);
  }) as typeof fetch;
}

function networkOf(state: FakeCrp) {
  return { crpBaseUrl: CRP_BASE, crpToken: CRP_TOKEN, crpFetch: crpFetchOf(state) };
}

// ---------------------------------------------------------------------------
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  projectId: string;
};

let fixture: Fixture;

async function cleanup(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  await prisma.releaseUpdateRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.crpCallLog.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { name: MANAGER_NAME } });

  const baselines = await prisma.baseline.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const baselineIds = baselines.map((item) => item.id);

  await prisma.baselinePackageVersion.deleteMany({ where: { baselineId: { in: baselineIds } } });
  await prisma.baseline.deleteMany({ where: { id: { in: baselineIds } } });

  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} 开发者`,
    },
    select: { id: true },
  });

  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: {
      crpBranchId: CRP_BRANCH_ID,
      name: `${PREFIX}-baseline`,
      arches: ["amd64"],
      syncedAt: new Date("2026-11-18T00:00:00Z"),
    },
    select: { id: true },
  });

  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: MANAGER_NAME },
    select: { id: true },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: PROJECT_KEY,
      name: `${PREFIX} 项目`,
    },
    select: { id: true },
  });

  fixture = { workspaceId: workspace.id, userId: user.id, projectId: project.id };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** Topic ID 在库里唯一，每条用例给一个自己的。 */
let topicSeq = 0;

function nextTopicId(): string {
  topicSeq += 1;

  return String(996050 + topicSeq);
}

/** CRP Release ID 在库里唯一，同样每条用例各自一段。 */
let releaseIdSeq = 0;

function nextCrpReleaseId(): string {
  releaseIdSeq += 1;

  return String(9540100 + releaseIdSeq);
}

type ReleaseSeed = {
  version: string;
  source?: "platform" | "imported";
  status?: "pending" | "building" | "success" | "abandoned";
  /** 不给就自己生成一个；给 `null` 表示还没建 Topic。 */
  topicId?: string | null;
  /** 当前轮里已经拿到 CRP Release 的包名（按包名排序）。 */
  released: string[];
};

/** 建一条提测，并给 `released` 里的每个包挂一条当前轮快照与一条 CRP 仓库记录。 */
async function createReleaseRow(
  seed: ReleaseSeed,
): Promise<{ releaseId: string; topicId: string | null; crpReleaseIds: string[] }> {
  const topicId = seed.topicId === undefined ? nextTopicId() : seed.topicId;
  const status = seed.status ?? "success";

  const created = await prisma.release.create({
    data: {
      projectId: fixture.projectId,
      version: seed.version,
      revision: 1,
      status,
      source: seed.source ?? "platform",
      createdById: fixture.userId,
      crpTopicId: topicId,
      crpBranchId: CRP_BRANCH_ID,
      crpTopicAbandoned: status === "abandoned",
      crpTopicCompleted: false,
      finishedAt: status === "abandoned" ? new Date() : null,
    },
    select: { id: true },
  });

  const crpReleaseIds: string[] = [];

  for (const packageName of [...seed.released].sort()) {
    const crpReleaseId = nextCrpReleaseId();
    crpReleaseIds.push(crpReleaseId);

    const snapshot = await prisma.releasePackageSnapshot.create({
      data: {
        releaseId: created.id,
        packageName,
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "a".repeat(40),
        codeVersion: `${packageName}-1.0.0`,
        releaseVersion: `${packageName}-1.0.0`,
        status: "success",
        statusChangedAt: new Date("2026-11-19T02:00:00Z"),
      },
      select: { id: true },
    });

    await prisma.releaseRepositoryRecord.create({
      data: { releaseId: created.id, snapshotId: snapshot.id, crpReleaseId },
    });
  }

  return { releaseId: created.id, topicId, crpReleaseIds };
}

async function readRelease(releaseId: string) {
  return prisma.release.findUnique({
    where: { id: releaseId },
    select: { status: true, crpTopicAbandoned: true, finishedAt: true },
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("页面上的禁用与原因：四种不能取消的情况各有说法，能取消时没有原因", () => {
  const base = {
    source: "platform",
    status: "building",
    workProgress: 10,
    workProgressLabel: "更新",
  };

  assert.equal(cancelReleaseLockReason(base), null, "平台创建、未转测时可以取消");

  // 按来源分流：导入的提测不给这个入口，走「放弃提测主题」。
  const imported = cancelReleaseLockReason({ ...base, source: "imported" });

  assert.match(String(imported), /放弃提测主题/);
  assert.match(String(imported), /不能删/);

  assert.match(
    String(cancelReleaseLockReason({ ...base, status: "abandoned" })),
    /已经取消过/,
  );
  assert.match(
    String(cancelReleaseLockReason({ ...base, workProgress: null })),
    /读不到 CRP 的工作流进度/,
  );

  const transferred = cancelReleaseLockReason({
    ...base,
    workProgress: 20,
    workProgressLabel: "转测试中（无法更新包）",
  });

  assert.match(String(transferred), /已经转测/);
  assert.match(String(transferred), /20/);
  assert.match(String(transferred), /转测试中/);
});

test("AC1/AC3：未转测的平台提测，逐个删 Release 并放弃 Topic，本地置 abandoned", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-2.0.0`,
    released: [pkg("a"), pkg("b")],
  });

  const result = await cancelPlatformRelease(releaseId, { network: networkOf(state) });

  assert.deepEqual([...result.deletedReleaseIds].sort(), [...crpReleaseIds].sort());
  assert.equal(result.abandonedTopicId, topicId);
  assert.deepEqual(result.failures, []);

  // 先读进度，再逐个删，最后 GET 完整主题对象后 PUT 放弃。
  assert.deepEqual(state.received, [
    `GET /topics/${topicId}/workflow/info`,
    ...crpReleaseIds.map((id) => `DELETE /topic_releases/${id}`),
    `GET /topics/${topicId}`,
    `PUT /topics/${topicId}`,
  ]);

  // CRP 侧复查：主题确实已被放弃。
  assert.equal(state.topic.Abandoned, true);

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "abandoned");
  assert.equal(release?.crpTopicAbandoned, true);
  assert.ok(release?.finishedAt !== null);

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { status: true },
  });

  assert.deepEqual(
    snapshots.map((item) => item.status),
    ["abandoned", "abandoned"],
  );
});

test("AC4：已转测（WorkProgress >= 20）时服务端拒绝，一个删除请求都不发", async () => {
  const state = newFakeCrp();
  state.workProgress = 20;

  const { releaseId, topicId } = await createReleaseRow({
    version: `${PREFIX}-3.0.0`,
    released: [pkg("a")],
  });

  await assert.rejects(
    () => cancelPlatformRelease(releaseId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /已经转测/);
      assert.match(error.message, /20/);

      return true;
    },
  );

  assert.deepEqual(state.received, [`GET /topics/${topicId}/workflow/info`]);

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "success", "拒绝之后本地状态不动");
  assert.equal(release?.crpTopicAbandoned, false);
  assert.equal(release?.finishedAt, null);
});

test("导入的提测不能取消：服务端拒绝，且一个 CRP 请求都不发", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow({
    version: `${PREFIX}-4.0.0`,
    source: "imported",
    released: [pkg("a")],
  });

  await assert.rejects(
    () => cancelPlatformRelease(releaseId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /放弃提测主题/);

      return true;
    },
  );

  assert.deepEqual(state.received, [], "来源不符时连进度都不读");
  assert.equal((await readRelease(releaseId))?.status, "success");
});

test("AC4/接口：已转测时 `?action=cancel` 回 409 conflict，只读一次工作流进度", async () => {
  const state = newFakeCrp();
  state.workProgress = 20;

  const { releaseId, topicId } = await createReleaseRow({
    version: `${PREFIX}-11.0.0`,
    released: [pkg("a")],
  });

  const response = await cancelReleaseResponse(releaseId, { network: networkOf(state) });
  const body = (await response.json()) as { error: { code: string; message: string } };

  // 这处以前直接调 cancelRelease：任何人拿到提测 ID 就能绕过页面删掉已转测的提测。
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "conflict");
  assert.match(body.error.message, /已经转测/);
  assert.deepEqual(
    state.received,
    [`GET /topics/${topicId}/workflow/info`],
    "一条删除请求都不发",
  );
  assert.equal((await readRelease(releaseId))?.status, "success");
});

test("AC4/接口：导入来源的提测 `?action=cancel` 回 409 conflict，一个 CRP 请求都不发", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow({
    version: `${PREFIX}-12.0.0`,
    source: "imported",
    released: [pkg("a")],
  });

  const response = await cancelReleaseResponse(releaseId, { network: networkOf(state) });
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 409);
  assert.equal(body.error.code, "conflict");
  assert.deepEqual(state.received, [], "导入主题里的 Release 是别人投的，一条都不碰");
  assert.equal((await readRelease(releaseId))?.status, "success");
});

test("AC3/接口：未转测的平台提测 `?action=cancel` 回 200，逐个删 Release 并放弃 Topic", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-13.0.0`,
    released: [pkg("a")],
  });

  const response = await cancelReleaseResponse(releaseId, { network: networkOf(state) });
  const body = (await response.json()) as {
    action: string;
    deletedReleaseIds: string[];
    abandonedTopicId: string | null;
    failures: unknown[];
  };

  // 返回值结构与拆分前一致，路由里拼 JSON 的那几行不用改。
  assert.equal(response.status, 200);
  assert.equal(body.action, "cancel");
  assert.deepEqual(body.deletedReleaseIds, crpReleaseIds);
  assert.equal(body.abandonedTopicId, topicId);
  assert.deepEqual(body.failures, []);
  assert.equal((await readRelease(releaseId))?.status, "abandoned");
});

test("接口入口：同一条提测连打两次 `?action=cancel`，第二次回 409 conflict 而不是 500", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow({
    version: `${PREFIX}-14.0.0`,
    released: [pkg("a")],
  });

  const first = await cancelReleaseResponse(releaseId, { network: networkOf(state) });

  assert.equal(first.status, 200);

  // 第二次进来时库里已经是 abandoned（两道并发取消里后到的那条就是这个处境）：判定的第一道
  // 就是它，必须回 409 conflict，而不是让底层异常漏到框架层变成 500。
  // `POST` 那一层自己的 `try/catch` 在 node 测试进程里覆盖不到（`authorize()` 要 Next 的请求
  // 上下文），所以路由里对 `cancelReleaseResponse` 的调用必须 `await`，异常才落得进那段映射。
  const second = await cancelReleaseResponse(releaseId, { network: networkOf(state) });
  const body = (await second.json()) as { error: { code: string; message: string } };

  assert.equal(second.status, 409);
  assert.equal(body.error.code, "conflict");
  assert.match(body.error.message, /已经取消过/);
});

test("已经取消过的提测不能重复取消", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow({
    version: `${PREFIX}-5.0.0`,
    status: "abandoned",
    released: [pkg("a")],
  });

  await assert.rejects(
    () => cancelPlatformRelease(releaseId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /已经取消过/);

      return true;
    },
  );

  assert.deepEqual(state.received, []);
});

test("读不到工作流进度时拒绝取消，一个删除请求都不发", async () => {
  const state = newFakeCrp();
  state.workflowFails = true;

  const { releaseId, topicId } = await createReleaseRow({
    version: `${PREFIX}-6.0.0`,
    released: [pkg("a")],
  });

  await assert.rejects(
    () => cancelPlatformRelease(releaseId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 502);
      assert.match(error.message, /读不到 CRP 的工作流进度/);

      return true;
    },
  );

  assert.deepEqual(state.received, [`GET /topics/${topicId}/workflow/info`]);
  assert.equal((await readRelease(releaseId))?.status, "success");
});

test("AC5a：删除中途失败时，失败明细带回来、本地不写 abandoned、只删掉成功那条的仓库记录", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-7.0.0`,
    released: [pkg("a"), pkg("b")],
  });

  const failingId = crpReleaseIds[0];
  const succeedingId = crpReleaseIds[1];
  state.failDelete.add(Number(failingId));

  const result = await cancelPlatformRelease(releaseId, { network: networkOf(state) });

  // MUST：失败明细不能被吞掉，目标是哪一条、原因是什么都要带回来（页面照这两项显示）。
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.target, `release:${failingId}`);
  assert.match(String(result.failures[0]?.reason), /delete release failed/);

  // 单个删除失败不中断整体：另一条照常删掉。
  assert.deepEqual(result.deletedReleaseIds, [succeedingId]);

  // MUST：删除没全部成功就不放弃 Topic —— 一次都不该发出去。否则会留下
  // 「CRP 上主题已放弃、本地提测仍活跃」，投递定时器还会继续往那个主题里投 Release。
  assert.equal(result.abandonedTopicId, null);
  assert.equal(state.topic.Abandoned, false);
  assert.ok(
    !state.received.includes(`GET /topics/${topicId}`),
    "读主题对象是放弃主题的第一步，这一步也不该发生",
  );
  assert.ok(!state.received.includes(`PUT /topics/${topicId}`), "不该放弃主题");

  // MUST：有失败就不写成功状态，否则这条提测再也没法从界面清理。
  const release = await readRelease(releaseId);

  assert.equal(release?.status, "success");
  assert.equal(release?.crpTopicAbandoned, false);
  assert.equal(release?.finishedAt, null);

  const snapshots = await prisma.releasePackageSnapshot.findMany({
    where: { releaseId },
    select: { status: true },
  });

  assert.deepEqual(
    snapshots.map((item) => item.status),
    ["success", "success"],
    "快照状态也不能被写成 abandoned",
  );

  // 失败那条的仓库记录必须还在，否则重试就再也找不到它；删成功那条的记录已经删掉。
  const records = await prisma.releaseRepositoryRecord.findMany({
    where: { releaseId },
    select: { crpReleaseId: true },
  });

  assert.deepEqual(records.map((item) => item.crpReleaseId), [failingId]);
});

test("AC5b：故障解除后再点一次，只删剩下的那条，成功后状态为 abandoned", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-9.0.0`,
    released: [pkg("a"), pkg("b")],
  });

  const failingId = crpReleaseIds[0];
  const succeedingId = crpReleaseIds[1];
  state.failDelete.add(Number(failingId));

  const first = await cancelPlatformRelease(releaseId, { network: networkOf(state) });

  assert.equal(first.failures.length, 1);
  assert.equal(first.abandonedTopicId, null, "第一次不该放弃主题");
  assert.equal(state.topic.Abandoned, false);
  assert.equal((await readRelease(releaseId))?.status, "success");

  // 故障解除：CRP 恢复，下一次删除会成功。
  state.failDelete.clear();
  const before = state.received.length;

  const second = await cancelPlatformRelease(releaseId, { network: networkOf(state) });

  assert.deepEqual(second.failures, []);
  assert.deepEqual(second.deletedReleaseIds, [failingId]);
  assert.equal(second.abandonedTopicId, topicId, "删除全部成功后这一次才放弃主题");

  // 重试只碰还没删掉的那条：上一次已经删成功的 Release 一条 `DELETE` 都不该再发。
  const retryRequests = state.received.slice(before);

  assert.deepEqual(retryRequests, [
    `GET /topics/${topicId}/workflow/info`,
    `DELETE /topic_releases/${failingId}`,
    `GET /topics/${topicId}`,
    `PUT /topics/${topicId}`,
  ]);
  assert.ok(
    !retryRequests.includes(`DELETE /topic_releases/${succeedingId}`),
    "重试不该再对着已经删掉的 Release 发 DELETE",
  );

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "abandoned");
  assert.equal(release?.crpTopicAbandoned, true);
  assert.ok(release?.finishedAt !== null);

  const records = await prisma.releaseRepositoryRecord.count({ where: { releaseId } });

  assert.equal(records, 0, "两条 Release 都删掉之后不该再留仓库记录");
});

test("AC5c：CRP 上已经没有那条 Release（DELETE 回 404）时按删成功处理，取消能收尾", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-10.0.0`,
    released: [pkg("a")],
  });

  const goneId = crpReleaseIds[0];
  state.notFoundDelete.add(Number(goneId));

  const result = await cancelPlatformRelease(releaseId, { network: networkOf(state) });

  // 404 表示「CRP 上没有这条 Release」，删除想要的结果已经达成，不该计入失败。
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.deletedReleaseIds, [goneId]);
  assert.equal(result.abandonedTopicId, topicId);

  const records = await prisma.releaseRepositoryRecord.count({ where: { releaseId } });

  assert.equal(records, 0, "仓库记录也要一并删掉，否则重试还会再发一次 DELETE");

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "abandoned");
  assert.equal(release?.crpTopicAbandoned, true);
  assert.ok(release?.finishedAt !== null);
});

test("确认框用的 Release 条数只数当前轮，被换掉的历史轮不算", async () => {
  const { releaseId, crpReleaseIds } = await createReleaseRow({
    version: `${PREFIX}-8.0.0`,
    released: [pkg("a")],
  });

  assert.equal(await loadCancelableReleaseCount(releaseId), 1);

  // 造一轮被换掉的历史：同一个包的第 1 轮指向第 2 轮，第 1 轮也挂着一条仓库记录。
  const current = await prisma.releasePackageSnapshot.findFirstOrThrow({
    where: { releaseId, packageName: pkg("a") },
    select: { id: true },
  });

  const old = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId,
      packageName: pkg("a"),
      attempt: 2,
      branch: "develop/eagle",
      commitSha: "b".repeat(40),
      codeVersion: `${pkg("a")}-0.9.0`,
      releaseVersion: `${pkg("a")}-0.9.0`,
      status: "success",
      supersededById: current.id,
      supersededAt: new Date("2026-11-19T03:00:00Z"),
    },
    select: { id: true },
  });

  await prisma.releaseRepositoryRecord.create({
    data: { releaseId, snapshotId: old.id, crpReleaseId: nextCrpReleaseId() },
  });

  assert.equal(
    await loadCancelableReleaseCount(releaseId),
    1,
    "历史轮的 Release 在换包时就删掉了，取消不会再动它",
  );
  assert.equal(crpReleaseIds.length, 1);

  // 清理这条只在本用例里用的历史轮，避免影响其它用例的清理顺序。
  await prisma.releaseRepositoryRecord.deleteMany({ where: { snapshotId: old.id } });
  await prisma.releasePackageSnapshot.delete({ where: { id: old.id } });
});
