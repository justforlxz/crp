/**
 * 「放弃提测主题」的集成测试：连真数据库，只有 CRP 那一层换成假的。
 *
 * 走的是生产代码的完整链路：`abandonReleaseTopic` → 现读 CRP 工作流 → `abandonTopic`
 * （先 GET 完整对象、再原样 PUT 只改 `Abandoned`）→ 回写本地状态与审计行。
 *
 * 锁住本节点的验收标准：
 *
 * - AC1：未转测的提测可以放弃，CRP 侧复查 `Abandoned=true`，本地状态 `abandoned`；
 * - AC2：PUT 的是 GET 回来的完整对象，`Name`、`NameB64`、`BranchID`、`Owner`、`Type`、
 *   `RepoType` 等原值一个不丢，只把 `Abandoned` 置真；
 * - AC3：已转测（`WorkProgress >= 20`）时服务端拒绝，且一个 PUT 都不发；
 * - AC4：CRP 写失败时本地状态保持原样，也不留审计行；
 * - AC5：审计行记下操作人、时间与被放弃的 Topic。
 *
 * 另外两条边界也在这里锁住：还没有建 Topic 的提测没有可放弃的主题；已经放弃过的不能重复放弃。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { prisma } from "../lib/db";
import { POST as abandonRoute } from "../app/api/releases/[id]/abandon/route";
import { createCrpClient, CrpError } from "../lib/integrations/crp";
import {
  abandonReleaseTopic,
  abandonTopicLockReason,
  loadCrpTopicName,
  ReleaseError,
} from "../lib/releases";

const PREFIX = "zza21";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const MANAGER_NAME = `${PREFIX}-manager`;
const PROJECT_KEY = `${PREFIX}-proj`;
const CRP_BRANCH_ID = "8860950";
const CRP_BASE = "https://crp.example.test/api";

/** GET 回来的主题对象：每个字段都带可对照的值，AC2 逐项比。 */
const TOPIC_NAME = `${PROJECT_KEY}-2.0.0`;
const TOPIC_NAME_B64 = Buffer.from(TOPIC_NAME, "utf8").toString("base64");

type FakeCrp = {
  /** 主题对象；PUT 成功后 `Abandoned` 置真，供「复查」用。 */
  topic: Record<string, unknown>;
  /** `PUT /topics/{id}` 收到的请求体，按次数追加。 */
  putBodies: Array<Record<string, unknown>>;
  /** 按顺序记下每一次请求，用来验「先 GET 再 PUT」。 */
  received: string[];
  /** `GET /topics/{id}/workflow/info` 返回的进度。 */
  workProgress: number;
  /** 让工作流接口报错，验「读不到就拒绝」。 */
  workflowFails: boolean;
  /** 让 PUT 报错，验 AC4。 */
  putFails: boolean;
};

function newFakeCrp(): FakeCrp {
  return {
    topic: {
      Name: TOPIC_NAME,
      NameB64: TOPIC_NAME_B64,
      Description: `主题说明 ${TOPIC_NAME}`,
      TpcType: "public",
      BranchID: Number(CRP_BRANCH_ID),
      Type: "test",
      RepoType: "deb",
      SyncID: 0,
      State: 5,
      Owner: [
        { employeeid: "1", mail: "crp-user@example.com", name: "crp-user", namecn: "CRP 用户" },
      ],
      Members: [{ employeeid: "2", mail: "member@example.com", name: "member-user" }],
      Abandoned: false,
      Completed: false,
      CopyId: null,
    },
    putBodies: [],
    received: [],
    workProgress: 0,
    workflowFails: false,
    putFails: false,
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

/** 假 CRP：响应形态按 `lib/integrations/crp/FINDINGS.md` 里实测的那几条写。 */
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

    const topic = /^\/topics\/(\d+)$/.exec(path);

    if (method === "GET" && topic !== null) {
      return json(JSON.stringify({ ...state.topic, ID: Number(topic[1]) }));
    }

    if (method === "PUT" && topic !== null) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.putBodies.push(body);

      if (state.putFails) {
        return json(JSON.stringify({ message: "update topic failed" }), 500);
      }

      state.topic = { ...state.topic, Abandoned: body.Abandoned === true };

      return json(JSON.stringify({ ...state.topic, ID: Number(topic[1]) }));
    }

    return json(JSON.stringify({ message: `测试没有实现 ${method} ${path}` }), 404);
  }) as typeof fetch;
}

function clientOf(state: FakeCrp): ReturnType<typeof createCrpClient> {
  return createCrpClient({
    baseUrl: CRP_BASE,
    token: "test-token",
    tokenKey: null,
    fetchImpl: crpFetchOf(state),
    sleepImpl: async () => {},
  });
}

function networkOf(state: FakeCrp) {
  return { crpBaseUrl: CRP_BASE, crpToken: "test-token", crpFetch: crpFetchOf(state) };
}

// ---------------------------------------------------------------------------
// 数据库夹具
// ---------------------------------------------------------------------------

type Fixture = {
  workspaceId: string;
  userId: string;
  baselineId: string;
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

  fixture = {
    workspaceId: workspace.id,
    userId: user.id,
    baselineId: baseline.id,
    projectId: project.id,
  };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** Topic ID 在库里唯一，每条用例给一个自己的。 */
let topicSeq = 0;

function nextTopicId(): string {
  topicSeq += 1;

  return String(995050 + topicSeq);
}

/** 一条已建好 Topic、正在构建的提测。版本号与 Topic ID 都各不相同。 */
async function createReleaseRow(version: string): Promise<{ releaseId: string; topicId: string }> {
  const topicId = nextTopicId();
  const created = await prisma.release.create({
    data: {
      projectId: fixture.projectId,
      version,
      revision: 1,
      status: "building",
      source: "imported",
      createdById: fixture.userId,
      crpTopicId: topicId,
      crpBranchId: CRP_BRANCH_ID,
      crpTopicAbandoned: false,
      crpTopicCompleted: false,
    },
    select: { id: true },
  });

  return { releaseId: created.id, topicId };
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

test("AC1/AC2：未转测的主题先 GET 再原样 PUT，只把 Abandoned 置真", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId } = await createReleaseRow(`${PREFIX}-2.0.0`);

  await abandonReleaseTopic(releaseId, fixture.userId, { network: networkOf(state) });

  // 先读再写：PUT 之前一定有一次 GET。
  assert.deepEqual(state.received, [
    `GET /topics/${topicId}/workflow/info`,
    `GET /topics/${topicId}`,
    `PUT /topics/${topicId}`,
  ]);

  assert.equal(state.putBodies.length, 1);
  const body = state.putBodies[0] as Record<string, unknown>;

  // AC2：原样带回的字段一个不丢。
  assert.equal(body.Name, TOPIC_NAME);
  assert.equal(body.NameB64, TOPIC_NAME_B64);
  assert.equal(body.Description, `主题说明 ${TOPIC_NAME}`);
  assert.equal(body.TpcType, "public");
  assert.equal(body.BranchID, Number(CRP_BRANCH_ID));
  assert.equal(body.Type, "test");
  assert.equal(body.RepoType, "deb");
  assert.equal(body.SyncID, 0);
  assert.equal(body.State, 5);
  assert.equal(body.Completed, false);
  assert.equal(body.CopyId, null);
  // Owner / Members 在响应里是对象数组，写回去是逗号拼接（只有一项时就是它自己）。
  assert.equal(body.Owner, "crp-user");
  assert.equal(body.Members, "member-user");
  // 唯一被改的就是这个字段。
  assert.equal(body.Abandoned, true);

  // AC1：复查 CRP 侧，主题确实已被放弃。
  const reread = await clientOf(state).getTopic(Number(topicId));
  assert.equal(reread.abandoned, true);
});

test("AC1/AC5：放弃成功后本地状态置 abandoned，并留下操作人、时间与 Topic 的审计行", async () => {
  const state = newFakeCrp();
  const { releaseId, topicId } = await createReleaseRow(`${PREFIX}-3.0.0`);

  const result = await abandonReleaseTopic(releaseId, fixture.userId, {
    network: networkOf(state),
  });

  assert.equal(result.topicId, topicId);
  assert.equal(result.topicName, TOPIC_NAME);

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "abandoned");
  assert.equal(release?.crpTopicAbandoned, true);
  assert.equal(release?.finishedAt?.toISOString(), result.abandonedAt.toISOString());

  const records = await prisma.releaseUpdateRecord.findMany({
    where: { releaseId },
    select: {
      action: true,
      operatorId: true,
      createdAt: true,
      abandonedTopicId: true,
      packageNames: true,
      abandonedCrpReleaseIds: true,
      revisionBefore: true,
      revisionAfter: true,
    },
  });

  assert.equal(records.length, 1, "一次放弃只写一行审计");
  const record = records[0];

  assert.equal(record?.action, "abandon_topic");
  assert.equal(record?.operatorId, fixture.userId);
  assert.equal(record?.abandonedTopicId, topicId);
  assert.equal(record?.createdAt.toISOString(), result.abandonedAt.toISOString());
  assert.deepEqual(record?.packageNames, []);
  assert.deepEqual(record?.abandonedCrpReleaseIds, []);
  assert.equal(record?.revisionBefore, 1);
  assert.equal(record?.revisionAfter, 1);
});

test("AC3：已转测（WorkProgress >= 20）时服务端拒绝，一个 PUT 都不发", async () => {
  const state = newFakeCrp();
  state.workProgress = 20;
  const { releaseId } = await createReleaseRow(`${PREFIX}-4.0.0`);

  await assert.rejects(
    () => abandonReleaseTopic(releaseId, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /已经转测/);
      assert.match(error.message, /20/);

      return true;
    },
  );

  assert.equal(state.putBodies.length, 0);
  const release = await readRelease(releaseId);
  assert.equal(release?.status, "building", "拒绝之后本地状态不动");
  assert.equal(release?.crpTopicAbandoned, false);
  assert.equal(await prisma.releaseUpdateRecord.count({ where: { releaseId } }), 0);
});

test("读不到工作流进度时拒绝放弃，不发 PUT", async () => {
  const state = newFakeCrp();
  state.workflowFails = true;
  const { releaseId } = await createReleaseRow(`${PREFIX}-5.0.0`);

  await assert.rejects(
    () => abandonReleaseTopic(releaseId, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 502);
      assert.match(error.message, /读不到 CRP 的工作流进度/);

      return true;
    },
  );

  assert.equal(state.putBodies.length, 0);
  assert.equal((await readRelease(releaseId))?.status, "building");
});

test("AC4：CRP 写失败时本地状态保持原样，也不留审计行", async () => {
  const state = newFakeCrp();
  state.putFails = true;
  const { releaseId } = await createReleaseRow(`${PREFIX}-6.0.0`);

  await assert.rejects(
    () => abandonReleaseTopic(releaseId, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof CrpError, "CRP 的错误原样交出去，由接口层翻成 502");

      return true;
    },
  );

  const release = await readRelease(releaseId);

  assert.equal(release?.status, "building");
  assert.equal(release?.crpTopicAbandoned, false);
  assert.equal(release?.finishedAt, null);
  assert.equal(await prisma.releaseUpdateRecord.count({ where: { releaseId } }), 0);
});

test("还没有建 Topic 的提测没有可放弃的主题", async () => {
  const state = newFakeCrp();
  const created = await prisma.release.create({
    data: {
      projectId: fixture.projectId,
      version: `${PREFIX}-7.0.0`,
      revision: 1,
      status: "pending",
      source: "imported",
      createdById: fixture.userId,
    },
    select: { id: true },
  });

  await assert.rejects(
    () => abandonReleaseTopic(created.id, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /还没有建 Topic/);

      return true;
    },
  );

  assert.deepEqual(state.received, []);
});

test("已经放弃过的主题不能重复放弃", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow(`${PREFIX}-8.0.0`);

  await prisma.release.update({
    where: { id: releaseId },
    data: { status: "abandoned", crpTopicAbandoned: true, finishedAt: new Date() },
  });

  await assert.rejects(
    () => abandonReleaseTopic(releaseId, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /已经放弃/);

      return true;
    },
  );

  assert.deepEqual(state.received, []);
});

test("确认框用的主题名读得到就返回，读不到返回 null 而不抛错", async () => {
  const state = newFakeCrp();
  const topicId = nextTopicId();

  assert.equal(await loadCrpTopicName(topicId, networkOf(state)), TOPIC_NAME);
  assert.equal(await loadCrpTopicName(null, networkOf(state)), null, "还没建 Topic 时不必读");

  // GET /topics/{id} 报 500：页面渲染不能因为这个读不到就打不开。
  const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);

    if (/^\/topics\/\d+$/.test(path)) {
      return json(JSON.stringify({ message: "topic unavailable" }), 500);
    }

    return crpFetchOf(state)(input, init);
  }) as typeof fetch;

  assert.equal(
    await loadCrpTopicName(topicId, {
      crpBaseUrl: CRP_BASE,
      crpToken: "test-token",
      crpFetch: failingFetch,
    }),
    null,
  );
});

test("页面上的禁用与原因：四种不能放弃的情况各有说法，能放弃时没有原因", () => {
  const base = {
    source: "imported",
    status: "building",
    crpTopicId: "995099",
    crpTopicAbandoned: false,
    workProgress: 0,
    workProgressLabel: "未开始",
  };

  assert.equal(abandonTopicLockReason(base), null, "导入的提测在未转测时就能放弃");

  // 按来源分流：平台创建的提测不给这个入口，走「取消提测」。
  assert.match(
    String(abandonTopicLockReason({ ...base, source: "platform" })),
    /取消提测/,
  );

  assert.match(
    String(abandonTopicLockReason({ ...base, crpTopicId: null })),
    /还没有建 Topic/,
  );

  assert.match(
    String(abandonTopicLockReason({ ...base, crpTopicAbandoned: true })),
    /已经放弃/,
  );

  // 本地状态是 abandoned 但字段为空（历史数据）时同样不能放弃。
  assert.match(
    String(abandonTopicLockReason({ ...base, status: "abandoned" })),
    /已经放弃/,
  );

  assert.match(
    String(abandonTopicLockReason({ ...base, workProgress: null })),
    /读不到 CRP 的工作流进度/,
  );

  const transferred = abandonTopicLockReason({ ...base, workProgress: 20, workProgressLabel: "转测试中（无法更新包）" });

  assert.match(String(transferred), /已经转测/);
  assert.match(String(transferred), /20/);
  assert.match(String(transferred), /转测试中/);
});

test("放弃主题接口：提测不存在时 404，不泄露它是否存在", async () => {
  const response = await abandonRoute(
    new Request("http://localhost/api/releases/not-a-release/abandon", { method: "POST" }),
    { params: Promise.resolve({ id: "01a1ee26-0000-0000-0000-000000000000" }) },
  );

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "release_not_found");
});

test("平台创建的提测不能只放弃主题：服务端拒绝，且一个 CRP 请求都不发", async () => {
  const state = newFakeCrp();
  const topicId = nextTopicId();
  const created = await prisma.release.create({
    data: {
      projectId: fixture.projectId,
      version: `${PREFIX}-9.0.0`,
      revision: 1,
      status: "building",
      source: "platform",
      createdById: fixture.userId,
      crpTopicId: topicId,
      crpBranchId: CRP_BRANCH_ID,
      crpTopicAbandoned: false,
    },
    select: { id: true },
  });

  await assert.rejects(
    () => abandonReleaseTopic(created.id, fixture.userId, { network: networkOf(state) }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.status, 409);
      assert.match(error.message, /取消提测/);

      return true;
    },
  );

  assert.deepEqual(state.received, [], "来源不符时连进度都不读");
  assert.equal((await readRelease(created.id))?.status, "building");
});

test("放弃主题时 CRP 返回空对象，不发出覆盖式的 PUT", async () => {
  const state = newFakeCrp();
  const { releaseId } = await createReleaseRow(`${PREFIX}-10.0.0`);

  // GET /topics/{id} 返回 200 但响应体为空：请求层给回 null。
  const emptyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);

    if (/^\/topics\/\d+$/.test(path) && (init?.method ?? "GET") === "GET") {
      state.received.push(`GET ${path}`);

      return new Response("", { status: 200 });
    }

    return crpFetchOf(state)(input, init);
  }) as typeof fetch;

  await assert.rejects(
    () =>
      abandonReleaseTopic(releaseId, fixture.userId, {
        network: { crpBaseUrl: CRP_BASE, crpToken: "test-token", crpFetch: emptyFetch },
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpError);
      assert.match(error.message, /没有返回主题对象/);

      return true;
    },
  );

  assert.equal(state.putBodies.length, 0, "读不到完整对象就不写");
  assert.equal((await readRelease(releaseId))?.status, "building");
});
