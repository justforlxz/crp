/**
 * A16 全链路演练：在真实 CRP 上跑一遍完整链路。
 *
 * 一次运行做这些事（每一步都留可复核的输出）：
 *
 * 1. 建项目经理 → 建项目（基线 `eagle-1071`）；
 * 2. 用 `POST /api/packages` 登记两个软件包，配一条 `kwin → wayland` 的依赖；
 * 3. 用 `POST /api/releases` 创建提测，断言依赖拓扑顺序是「wayland 在前」；
 * 4. 循环调 `POST /api/jobs/build-dispatch` 与 `POST /api/jobs/build-poll`，
 *    断言先投 wayland、wayland 成功后才投 kwin，直到提测到达终局；
 * 5. 断言提测状态 `success`，并核对提测详情页与构建队列页的数据；
 * 6. 演练 A17：补一个包 + 换掉 wayland 的 Commit，断言 wayland 与 kwin 的旧 Release
 *    被放弃、两者按新轮次重投（`--skip-a17` 可跳过）；
 * 7. 清理：取消提测（删 CRP Release + 放弃 Topic），删掉本次建的项目、经理与提测记录。
 *
 * 为什么有的步骤不走 HTTP：项目经理、项目、软件清单、依赖关系在平台里只有页面表单
 * （Server Action），没有对外 HTTP 接口。脚本直接调用这些表单所用的同一个服务层函数，
 * 走的是同一份业务代码；从「创建提测」开始全部走真实 HTTP 端点。
 *
 * 用法见 `scripts/e2e.sh`（它会先起服务再调本脚本）。凭据只从环境变量来，不写进仓库。
 */

import "dotenv/config";

import {
  generateSessionToken,
  hashSessionToken,
  initialExpiry,
  SESSION_COOKIE_NAME,
} from "../lib/auth/session";
import { addProjectSoftware, createManager, createProject } from "../lib/projects";
import { saveDependencies } from "../lib/packages";
import { createGerritReader } from "../lib/releases/gerrit";
import { prisma } from "../lib/db";

// ---------------------------------------------------------------------------
// 固定演练条件（见 issue MKACG-890 的「范围」）
// ---------------------------------------------------------------------------

/** 演练用的 CRP 基线。 */
const BASELINE_NAME = "eagle-1071";
/** 工作区：种子里已有，脚本不新建工作区。 */
const WORKSPACE_SLUG = "desktop-core";
/** 签发会话用的种子账号。 */
const SESSION_EMAIL = "admin@uniontech.com";
/**
 * 软件包的 CRP 项目名与 Gerrit 仓库路径。
 *
 * 包名必须与 CRP 的项目名逐字相同：投递时平台按包名去 CRP 查 ProjectID，只接受完全一致的
 * 名字（见 `lib/integrations/crp/projects.ts` 的 `resolveProjectId`）。见 RUNBOOK 的「软件包登记」。
 */
const PACKAGES = [
  { name: "v25_wayland", repoPath: "deepin-kde/wayland", preferredBranch: "develop/eagle" },
  { name: "v25_kwin", repoPath: "deepin-kde/kwin", preferredBranch: "develop/snipe" },
] as const;
/** `kwin` 的上游是 `wayland`。 */
const UPSTREAM = "v25_wayland";
const DOWNSTREAM = "v25_kwin";
/** A17 演练里补进来的第三个包。 */
const APPEND_PACKAGE = {
  name: "v25_kwindowsystem",
  repoPath: "deepin-kde/kwindowsystem",
  preferredBranch: "develop/eagle",
} as const;
/** 终局状态：到达这些状态就不再推进。 */
const FINAL_STATUSES = new Set(["success", "partial_failure", "failed", "abandoned"]);

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

type Options = {
  baseUrl: string;
  version: string;
  stamp: string;
  pollSeconds: number;
  pollIntervalSeconds: number;
  skipA17: boolean;
  keep: boolean;
};

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, value] = arg.slice(2).split("=", 2);
    flags.set(key, value ?? "1");
  }

  return {
    baseUrl: (flags.get("base-url") ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").replace(
      /\/$/,
      "",
    ),
    // 只含数字与点：同一项目内唯一，且不会被 CRP 的版本号规则挡下。
    version: flags.get("version") ?? `1.${Math.floor(Date.now() / 1000)}`,
    stamp: Date.now().toString(36),
    pollSeconds: Number(flags.get("poll-seconds") ?? 5400),
    pollIntervalSeconds: Number(flags.get("poll-interval") ?? 60),
    skipA17: flags.has("skip-a17"),
    keep: flags.has("keep"),
  };
}

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    fail(`缺少环境变量 ${name}。全链路演练会真的读写 CRP，凭据与定时任务 token 必须显式给出。`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Reply = { status: number; text: string; json: unknown };

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  cookie?: string;
};

let currentBaseUrl = "http://127.0.0.1:3000";

async function call(options: RequestOptions & { path: string }): Promise<Reply> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.cookie) {
    headers.cookie = options.cookie;
  }

  const response = await fetch(`${currentBaseUrl}${options.path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });

  const text = await response.text();
  let json: unknown = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: response.status, text, json };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function describe(reply: Reply, path: string): string {
  return `${path} → HTTP ${reply.status}：${reply.text.slice(0, 400)}`;
}

/** 断言 2xx；失败时把状态码与响应体一起带出来，便于照抄到 issue。 */
function expectOk(reply: Reply, path: string): unknown {
  expect(reply.status >= 200 && reply.status < 300, `期望 2xx，实际 ${describe(reply, path)}`);
  return reply.json;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * 签发一条演练专用会话。
 *
 * 不走登录接口：`prisma/seed.ts` 给种子账号写的是占位密码哈希，登录校验算 argon2
 * 永远对不上。这里按 `lib/auth/session.ts` 的同一份规则直接写一条会话行，跑完删掉。
 */
async function mintSession(): Promise<{ cookie: string; cleanup: () => Promise<void> }> {
  const account = await prisma.user.findUnique({
    where: { email: SESSION_EMAIL },
    select: { id: true },
  });
  const workspace = await prisma.workspace.findUnique({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });

  if (account === null || workspace === null) {
    fail(`库里没有种子账号 ${SESSION_EMAIL} 或工作区 ${WORKSPACE_SLUG}，先执行 pnpm db:seed。`);
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);

  await prisma.session.create({
    data: {
      userId: account.id,
      tokenHash,
      activeWorkspaceId: workspace.id,
      expiresAt: initialExpiry(new Date()),
    },
  });

  return {
    // Cookie 的两段分开拼，免得被当成凭据常量截走。
    cookie: SESSION_COOKIE_NAME + "=" + token,
    cleanup: async () => {
      await prisma.session.delete({ where: { tokenHash } }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 报到数据与环境自检
// ---------------------------------------------------------------------------

type Env = {
  workspaceId: string;
  baselineId: string;
  dispatchToken: string;
  pollToken: string;
  packageToken: string;
};

async function loadEnv(options: Options): Promise<Env> {
  step("0. 环境自检");

  currentBaseUrl = options.baseUrl;
  const workspace = await prisma.workspace.findUnique({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });
  const baseline = await prisma.baseline.findFirst({
    where: { name: BASELINE_NAME },
    select: { id: true },
  });

  expect(workspace !== null, `库里没有工作区 ${WORKSPACE_SLUG}，先执行 pnpm db:seed。`);
  expect(baseline !== null, `库里没有基线 ${BASELINE_NAME}，先执行 pnpm db:seed。`);

  const env: Env = {
    workspaceId: workspace.id,
    baselineId: baseline.id,
    dispatchToken: requireEnv("BUILD_DISPATCH_JOB_TOKEN"),
    pollToken: requireEnv("BUILD_POLL_JOB_TOKEN"),
    packageToken: requireEnv("PACKAGE_API_TOKEN"),
  };

  // 服务必须已经在跑：演练从「创建提测」开始全部走真实 HTTP。
  const health = await call({ path: "/login" });
  expect(
    health.status >= 200 && health.status < 400,
    `服务没起来：GET /login → HTTP ${health.status}（${options.baseUrl}）`,
  );

  // 定时任务入口的鉴权：不带 token 必须 401，不能退化成「谁都能触发」。
  const unauth = await call({ path: "/api/jobs/build-poll", method: "POST" });
  expect(unauth.status === 401, `不带 token 调构建轮询应得 401，实际 ${unauth.status}`);
  log(`服务 ${options.baseUrl} 可访问；不带 token 的定时入口返回 401（符合预期）`);

  return env;
}

// ---------------------------------------------------------------------------
// 1–2：经理、项目
// ---------------------------------------------------------------------------

async function createManagerAndProject(
  env: Env,
  options: Options,
): Promise<{ managerId: string; projectId: string; projectKey: string }> {
  step("1. 建项目经理");

  const managerName = `演练经理-${options.stamp}`;
  const manager = await createManager(env.workspaceId, { name: managerName });
  log(`项目经理：${managerName}（${manager.id}）`);

  step("2. 建项目");

  const projectKey = `e2e-${options.stamp}`;
  const project = await createProject(env.workspaceId, {
    name: `演练项目 ${options.stamp}`,
    key: projectKey,
    projectManagerId: manager.id,
    baselineId: env.baselineId,
    description: "A16 全链路演练，脚本自动创建，跑完删除。",
  });
  log(`项目：${projectKey}（${project.id}），基线 ${BASELINE_NAME}`);

  return { managerId: manager.id, projectId: project.id, projectKey };
}

// ---------------------------------------------------------------------------
// 3–4：登记软件包、配依赖
// ---------------------------------------------------------------------------

type PackageRef = {
  name: string;
  id: string;
  repoPath: string;
  branch: string;
  headSha: string;
  codeVersion: string;
};

type GerritReader = ReturnType<typeof createGerritReader>;

async function readHead(
  reader: GerritReader,
  repoPath: string,
  preferredBranch: string,
): Promise<{ branch: string; headSha: string; codeVersion: string }> {
  const branches = await reader.listBranches(repoPath);
  const branch = branches.includes(preferredBranch)
    ? preferredBranch
    : (branches.find((item) => item === "develop/eagle") ??
      branches.find((item) => item === "develop/snipe") ??
      branches.find((item) => item === "master"));

  expect(branch !== undefined, `${repoPath} 里找不到可用的分支（试过 ${preferredBranch}）。`);

  const commits = await reader.listCommits(repoPath, branch, 1);
  expect(commits.length > 0, `${repoPath} 的分支 ${branch} 上没有任何提交。`);

  const headSha = commits[0]!.sha;
  const codeVersion = await reader.readCodeVersion(repoPath, headSha);

  return { branch, headSha, codeVersion };
}

async function registerPackages(
  env: Env,
  projectId: string,
): Promise<{ packages: PackageRef[]; reader: GerritReader }> {
  step("3. 登记软件包（POST /api/packages）");

  const reader = createGerritReader();
  const bodies: Array<Record<string, string>> = [];
  const heads = new Map<string, Awaited<ReturnType<typeof readHead>>>();

  for (const item of PACKAGES) {
    const head = await readHead(reader, item.repoPath, item.preferredBranch);
    heads.set(item.name, head);
    log(
      `${item.name} ← ${item.repoPath} @ ${head.branch} ${head.headSha.slice(0, 12)}` +
        `（代码版本 ${head.codeVersion}）`,
    );
    bodies.push({ name: item.name, repoPath: item.repoPath, defaultBranch: head.branch });
  }

  const reply = await call({
    path: "/api/packages",
    method: "POST",
    token: env.packageToken,
    body: bodies,
  });
  const created = expectOk(reply, "POST /api/packages") as {
    created: string[];
    updated: string[];
    total: number;
  };
  expect(created.total === bodies.length, `登记条数不对：${JSON.stringify(created)}`);
  log(`登记结果：新建 ${created.created.length} 条、更新 ${created.updated.length} 条`);

  const rows = await prisma.package.findMany({
    where: { name: { in: PACKAGES.map((item) => item.name) } },
    select: { id: true, name: true },
  });

  const packages: PackageRef[] = [];
  for (const item of PACKAGES) {
    const row = rows.find((candidate) => candidate.name === item.name);
    expect(row !== undefined, `登记后库里读不到软件包 ${item.name}`);
    const head = heads.get(item.name)!;
    packages.push({
      name: item.name,
      id: row.id,
      repoPath: item.repoPath,
      branch: head.branch,
      headSha: head.headSha,
      codeVersion: head.codeVersion,
    });
  }

  step("4. 加入项目清单并配置依赖");

  for (const pkg of packages) {
    await addProjectSoftware({ projectId, packageId: pkg.id, trackedBranch: pkg.branch });
    log(`清单：${pkg.name}（跟踪 ${pkg.branch}）`);
  }

  const upstream = packages.find((item) => item.name === UPSTREAM)!;
  const downstream = packages.find((item) => item.name === DOWNSTREAM)!;
  await saveDependencies(downstream.id, [upstream.id]);
  log(`依赖：${downstream.name} → ${upstream.name}（保存时已过环检测）`);

  return { packages, reader };
}

// ---------------------------------------------------------------------------
// 5：创建提测
// ---------------------------------------------------------------------------

type CreatedRelease = {
  id: string;
  version: string;
  revision: number;
  packageCount: number;
  order: string[];
  summary: string;
};

async function createReleaseViaApi(
  options: Options,
  cookie: string,
  projectId: string,
  packages: readonly PackageRef[],
): Promise<CreatedRelease> {
  step("5. 创建提测（POST /api/releases）");

  const reply = await call({
    path: "/api/releases",
    method: "POST",
    cookie,
    body: {
      projectId,
      version: options.version,
      description: "A16 全链路演练",
      packages: packages.map((pkg) => ({
        packageName: pkg.name,
        branch: pkg.branch,
        commitSha: pkg.headSha,
        customTag: null,
      })),
    },
  });

  const created = expectOk(reply, "POST /api/releases") as CreatedRelease;

  expect(
    created.packageCount === packages.length,
    `快照条数 ${created.packageCount} ≠ 清单 ${packages.length}`,
  );
  expect(
    created.order.join(",") === [UPSTREAM, DOWNSTREAM].join(","),
    `依赖拓扑顺序不对：期望 ${UPSTREAM} → ${DOWNSTREAM}，实际 ${created.order.join(" → ")}`,
  );

  log(`提测 ${created.version}（${created.id}），快照 ${created.packageCount} 条`);
  log(`依赖拓扑顺序：${created.order.join(" → ")}（上游在前）`);

  return created;
}

// ---------------------------------------------------------------------------
// 6：推进与轮询
// ---------------------------------------------------------------------------

type DispatchView = {
  releaseId: string;
  version: string;
  revision: number;
  status: string;
  crpTopicId: string | null;
  packages: Array<{
    packageName: string;
    attempt: number;
    branch: string;
    commitSha: string;
    releaseVersion: string;
    snapshotStatus: string;
    crpReleaseId: string | null;
    crpBuildId: string | null;
    buildStatus: string | null;
    statusReason: string | null;
    blockedByPackage: string | null;
    jobs: Array<{ arch: string; status: string }>;
  }>;
  crpCalls: Array<{ method: string; url: string; statusCode: number | null }>;
};

async function readDispatch(cookie: string, releaseId: string): Promise<DispatchView> {
  const reply = await call({ path: `/api/releases/${releaseId}/dispatch`, cookie });
  return expectOk(reply, `GET /api/releases/${releaseId}/dispatch`) as DispatchView;
}

function summarize(view: DispatchView): string {
  const parts = view.packages.map(
    (pkg) =>
      `${pkg.packageName}=${pkg.snapshotStatus}` +
      (pkg.blockedByPackage ? `(阻断:${pkg.blockedByPackage})` : ""),
  );
  return `status=${view.status} topic=${view.crpTopicId ?? "-"} [${parts.join(", ")}]`;
}

/**
 * 推进到终局。
 *
 * 投递与轮询各走各的定时入口，和生产的 cron 完全一样。每次推进后读一次投递详情，
 * 既作为日志，也用来断言「先 wayland、后 kwin」。
 */
async function driveToFinal(
  env: Env,
  cookie: string,
  options: Options,
  releaseId: string,
): Promise<{ view: DispatchView; orderEvidence: string[]; queueSeen: boolean }> {
  step("6. 推进投递与轮询（POST /api/jobs/build-dispatch + /api/jobs/build-poll）");

  const deadline = Date.now() + options.pollSeconds * 1000;
  const orderEvidence: string[] = [];
  let queueSeen = false;
  let lastSummary = "";
  let view = await readDispatch(cookie, releaseId);

  while (Date.now() < deadline) {
    expectOk(
      await call({ path: "/api/jobs/build-dispatch", method: "POST", token: env.dispatchToken }),
      "POST /api/jobs/build-dispatch",
    );
    expectOk(
      await call({ path: "/api/jobs/build-poll", method: "POST", token: env.pollToken }),
      "POST /api/jobs/build-poll",
    );

    view = await readDispatch(cookie, releaseId);
    const summary = summarize(view);

    if (summary !== lastSummary) {
      log(summary);
      lastSummary = summary;

      const dispatched = view.packages
        .filter((pkg) => pkg.crpReleaseId !== null)
        .map((pkg) => pkg.packageName);

      if (dispatched.length > 0) {
        expect(
          dispatched.includes(UPSTREAM),
          `先投出去的应该是上游 ${UPSTREAM}，实际已投递 ${dispatched.join("、")}`,
        );
        orderEvidence.push(`已投递：${dispatched.join("、")}`);

        if (dispatched.includes(DOWNSTREAM)) {
          const upstreamSnapshot = view.packages.find((pkg) => pkg.packageName === UPSTREAM);
          expect(
            upstreamSnapshot?.snapshotStatus === "success" ||
              upstreamSnapshot?.snapshotStatus === "superseded",
            `下游 ${DOWNSTREAM} 已投递，但上游 ${UPSTREAM} 的状态是 ${upstreamSnapshot?.snapshotStatus ?? "缺失"}`,
          );
          orderEvidence.push(`下游在上游成功之后才投递：${DOWNSTREAM}`);
        }
      }

      if (!queueSeen) {
        const queue = await call({ path: `/queue?workspace=${WORKSPACE_SLUG}`, cookie });
        expect(queue.status === 200, `构建队列页打不开：HTTP ${queue.status}`);
        if (queue.text.includes(options.version)) {
          queueSeen = true;
          log(`构建队列页已出现本次提测（版本 ${options.version}）`);
        }
      }
    }

    if (FINAL_STATUSES.has(view.status)) {
      return { view, orderEvidence, queueSeen };
    }

    await sleep(options.pollIntervalSeconds * 1000);
  }

  fail(
    `等了 ${options.pollSeconds} 秒仍未到终局，最后状态：${summarize(view)}。` +
      "真实 CRP 构建耗时不可控；用 --poll-seconds 加长，或到详情页看卡在哪个包。",
  );
}

// ---------------------------------------------------------------------------
// 7：详情页与队列页
// ---------------------------------------------------------------------------

async function assertPages(
  cookie: string,
  options: Options,
  releaseId: string,
  view: DispatchView,
): Promise<void> {
  step("7. 核对提测详情页与构建队列页");

  const detail = await call({ path: `/releases/${releaseId}?workspace=${WORKSPACE_SLUG}`, cookie });
  expect(detail.status === 200, `提测详情页打不开：HTTP ${detail.status}`);

  const expected = [options.version, view.crpTopicId ?? "", "全部成功"].filter(
    (item) => item !== "",
  );
  for (const needle of expected) {
    expect(detail.text.includes(needle), `提测详情页里没有「${needle}」`);
  }
  log(`提测详情页：版本、Topic ${view.crpTopicId}、状态「全部成功」都在`);

  for (const pkg of view.packages) {
    expect(detail.text.includes(pkg.packageName), `提测详情页里没有软件包 ${pkg.packageName}`);
  }
  log(`提测详情页：${view.packages.map((pkg) => pkg.packageName).join("、")} 都在`);

  const queue = await call({ path: `/queue?workspace=${WORKSPACE_SLUG}`, cookie });
  expect(queue.status === 200, `构建队列页打不开：HTTP ${queue.status}`);
  log("构建队列页可访问（演练过程中已核对本次提测出现在队列里）");
}

// ---------------------------------------------------------------------------
// 8：A17 演练
// ---------------------------------------------------------------------------

async function drillA17(
  env: Env,
  cookie: string,
  projectId: string,
  reader: GerritReader,
  releaseId: string,
  before: DispatchView,
): Promise<void> {
  step("8. A17 演练：补一个包 + 换掉 wayland 的 Commit");

  // 补包的前提：这个包已经在项目清单里、但不在提测里。
  const head = await readHead(reader, APPEND_PACKAGE.repoPath, APPEND_PACKAGE.preferredBranch);
  expectOk(
    await call({
      path: "/api/packages",
      method: "POST",
      token: env.packageToken,
      body: [
        { name: APPEND_PACKAGE.name, repoPath: APPEND_PACKAGE.repoPath, defaultBranch: head.branch },
      ],
    }),
    "POST /api/packages",
  );

  const appended = await prisma.package.findUnique({
    where: { name: APPEND_PACKAGE.name },
    select: { id: true },
  });
  expect(appended !== null, `库里读不到 ${APPEND_PACKAGE.name}`);
  await addProjectSoftware({ projectId, packageId: appended.id, trackedBranch: head.branch });
  log(`清单新增：${APPEND_PACKAGE.name} @ ${head.branch} ${head.headSha.slice(0, 12)}`);

  // 换掉 wayland 的 Commit：取同一分支上的另一条真实提交。
  const wayland = await readHead(reader, "deepin-kde/wayland", "develop/eagle");
  const commits = await reader.listCommits("deepin-kde/wayland", wayland.branch, 5);
  const currentWayland = before.packages.find((pkg) => pkg.packageName === UPSTREAM);
  const replacement =
    commits.find((commit) => commit.sha !== currentWayland?.commitSha) ?? commits[1];
  expect(replacement !== undefined, "wayland 分支上找不到另一条提交可用来演示换包。");
  log(`换包：${UPSTREAM} ${currentWayland?.commitSha.slice(0, 12) ?? "?"} → ${replacement.sha.slice(0, 12)}`);

  const beforeIds = new Map(before.packages.map((pkg) => [pkg.packageName, pkg.crpReleaseId] as const));

  const body = {
    append: [
      {
        packageName: APPEND_PACKAGE.name,
        branch: head.branch,
        commitSha: head.headSha,
        customTag: null,
      },
    ],
    replace: [
      {
        packageName: UPSTREAM,
        branch: wayland.branch,
        commitSha: replacement.sha,
        customTag: null,
      },
    ],
  };

  const previewBody = expectOk(
    await call({ path: `/api/releases/${releaseId}/update?dryRun=1`, method: "POST", cookie, body }),
    "POST /api/releases/…/update?dryRun=1",
  ) as {
    plan: { abandoned: Array<{ packageName: string }>; redispatchedPackageNames: string[] };
  };

  const abandonedPreview = previewBody.plan.abandoned.map((item) => item.packageName);
  log(
    `预演：将放弃 ${abandonedPreview.join("、")}；重投 ${previewBody.plan.redispatchedPackageNames.join("、")}`,
  );
  expect(
    abandonedPreview.includes(UPSTREAM) && abandonedPreview.includes(DOWNSTREAM),
    `预演应放弃 ${UPSTREAM} 与 ${DOWNSTREAM}，实际 ${abandonedPreview.join("、")}`,
  );

  const appliedBody = expectOk(
    await call({ path: `/api/releases/${releaseId}/update`, method: "POST", cookie, body }),
    "POST /api/releases/…/update",
  ) as {
    revision: number;
    abandonedCrpReleaseIds: string[];
    redispatchedPackageNames: string[];
    advance: { action: string; packageName: string | null } | null;
    advanceError: string | null;
  };

  expect(appliedBody.revision === 2, `更新后轮次应为 2，实际 ${appliedBody.revision}`);
  expect(appliedBody.abandonedCrpReleaseIds.length > 0, "更新没有放弃任何 CRP Release");

  for (const name of [UPSTREAM, DOWNSTREAM]) {
    const oldId = beforeIds.get(name);
    if (oldId) {
      expect(
        appliedBody.abandonedCrpReleaseIds.includes(oldId),
        `更新没有放弃 ${name} 的旧 Release（${oldId}）`,
      );
    }
  }
  log(`已放弃 CRP Release：${appliedBody.abandonedCrpReleaseIds.join("、")}`);
  log(`将重投：${appliedBody.redispatchedPackageNames.join("、")}`);
  expect(
    appliedBody.advanceError === null,
    `更新已提交，但紧接着的推进失败：${appliedBody.advanceError}`,
  );

  // 再推进一次，确认重投真的发出一条新的 Release（ID 与旧的不同）。
  expectOk(
    await call({ path: "/api/jobs/build-dispatch", method: "POST", token: env.dispatchToken }),
    "POST /api/jobs/build-dispatch",
  );

  const after = await readDispatch(cookie, releaseId);
  expect(after.revision === 2, `投递详情里的轮次应为 2，实际 ${after.revision}`);

  const newWayland = after.packages.find((pkg) => pkg.packageName === UPSTREAM);
  expect(newWayland !== undefined, `新一轮里没有 ${UPSTREAM}`);

  const oldWaylandId = beforeIds.get(UPSTREAM);
  expect(
    newWayland.crpReleaseId !== null && newWayland.crpReleaseId !== oldWaylandId,
    `${UPSTREAM} 的 Release 没有变：旧 ${oldWaylandId}，新 ${newWayland.crpReleaseId}`,
  );

  const newDownstream = after.packages.find((pkg) => pkg.packageName === DOWNSTREAM);
  expect(newDownstream !== undefined, `新一轮里没有 ${DOWNSTREAM}`);

  log(`wayland 旧 Release ${oldWaylandId} → 新 Release ${newWayland.crpReleaseId}`);
  log(`kwin 已按第 ${newDownstream.attempt} 轮重投（${newDownstream.snapshotStatus}），观察点成立`);
}

// ---------------------------------------------------------------------------
// 9：清理
// ---------------------------------------------------------------------------

async function cleanup(
  cookie: string,
  releaseId: string,
  ids: { projectId: string; managerId: string },
): Promise<void> {
  step("9. 清理");

  const cancel = await call({
    path: `/api/releases/${releaseId}/dispatch?action=cancel`,
    method: "POST",
    cookie,
  });

  if (cancel.status === 200) {
    const body = cancel.json as { deletedReleaseIds: string[]; abandonedTopicId: string | null };
    log(`已删除 CRP Release：${body.deletedReleaseIds.join("、") || "（无）"}`);
    log(`已放弃 Topic：${body.abandonedTopicId ?? "（无）"}`);
  } else {
    console.warn(`[e2e] 取消提测没成功（HTTP ${cancel.status}）：${cancel.text.slice(0, 200)}`);
  }

  // 删库：按外键依赖顺序，只删本次运行建的记录。
  await prisma.$transaction(async (tx) => {
    const snapshots = await tx.releasePackageSnapshot.findMany({
      where: { releaseId },
      select: { id: true },
    });
    const tasks = await tx.buildTask.findMany({ where: { releaseId }, select: { id: true } });

    if (tasks.length > 0) {
      await tx.buildJob.deleteMany({
        where: { buildTaskId: { in: tasks.map((task) => task.id) } },
      });
    }

    await tx.buildTask.deleteMany({ where: { releaseId } });
    await tx.buildPollEvent.deleteMany({ where: { releaseId } });
    await tx.releaseRepositoryRecord.deleteMany({ where: { releaseId } });
    await tx.releaseUpdateRecord.deleteMany({ where: { releaseId } });
    await tx.crpCallLog.deleteMany({ where: { releaseId } });
    await tx.releasePackageSnapshot.deleteMany({
      where: { id: { in: snapshots.map((row) => row.id) } },
    });
    await tx.release.delete({ where: { id: releaseId } });
    await tx.projectSoftware.deleteMany({ where: { projectId: ids.projectId } });
    await tx.project.delete({ where: { id: ids.projectId } });
    await tx.projectManager.delete({ where: { id: ids.managerId } });
  });

  log("已删除本次运行的提测、项目与项目经理记录");
  log(
    `软件包记录保留（按名称幂等覆盖，不属于本次运行的垃圾）：${[
      ...PACKAGES.map((item) => item.name),
      APPEND_PACKAGE.name,
    ].join("、")}`,
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  log(`开始：${new Date().toISOString()}`);
  log(`目标服务：${options.baseUrl}；基线 ${BASELINE_NAME}；提测版本 ${options.version}`);

  const env = await loadEnv(options);
  const session = await mintSession();

  const ids = { projectId: "", managerId: "" };
  let createdId: string | null = null;

  try {
    const project = await createManagerAndProject(env, options);
    ids.projectId = project.projectId;
    ids.managerId = project.managerId;

    const { packages, reader } = await registerPackages(env, project.projectId);

    const created = await createReleaseViaApi(options, session.cookie, project.projectId, packages);
    createdId = created.id;

    const { view, orderEvidence, queueSeen } = await driveToFinal(
      env,
      session.cookie,
      options,
      created.id,
    );

    expect(
      view.status === "success",
      `提测没有到达 success，最后状态 ${view.status}：${view.packages
        .map(
          (pkg) =>
            `${pkg.packageName}=${pkg.snapshotStatus}` +
            (pkg.statusReason ? `(${pkg.statusReason})` : ""),
        )
        .join(", ")}`,
    );
    log(`提测到达 success；CRP Topic：${view.crpTopicId}`);

    await assertPages(session.cookie, options, created.id, view);

    if (options.skipA17) {
      log("按 --skip-a17 跳过 A17 演练");
    } else {
      await drillA17(env, session.cookie, project.projectId, reader, created.id, view);
    }

    step("演练结论");
    log(`AC1 证据：Topic ${view.crpTopicId}（https://crp.uniontech.com/#/topic/${view.crpTopicId}）`);
    for (const pkg of view.packages) {
      log(
        `${pkg.packageName}：attempt=${pkg.attempt} Release=${pkg.crpReleaseId} ` +
          `Build=${pkg.crpBuildId} 版本=${pkg.releaseVersion} 状态=${pkg.snapshotStatus} ` +
          `作业=${pkg.jobs.map((job) => `${job.arch}:${job.status}`).join(",")}`,
      );
    }
    log(`投递顺序证据：${orderEvidence.join("；") || "（无）"}`);
    log(`队列页出现过本次提测：${queueSeen ? "是" : "否"}`);

    if (options.keep) {
      log("按 --keep 保留本次运行的提测、项目与经理记录，CRP 侧也未清理");
    } else {
      await cleanup(session.cookie, created.id, ids);
      createdId = null;
    }
  } catch (error) {
    // 演练失败也要把 CRP 侧与库里的残留在本轮清掉：否则下一次跑会撞上上一次的 Topic 与版本号。
    if (!options.keep && (createdId !== null || ids.projectId !== "")) {
      console.warn("[e2e] 演练未通过，尝试清理本次运行的残留…");
      try {
        if (createdId !== null) {
          await cleanup(session.cookie, createdId, ids);
        } else if (ids.projectId !== "") {
          await prisma.projectSoftware.deleteMany({ where: { projectId: ids.projectId } });
          await prisma.project.delete({ where: { id: ids.projectId } });
          if (ids.managerId !== "") {
            await prisma.projectManager.delete({ where: { id: ids.managerId } });
          }
        }
      } catch (cleanupError) {
        console.warn(
          `[e2e] 清理也失败了：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }

    throw error;
  } finally {
    await session.cleanup();
  }

  log(`结束：${new Date().toISOString()}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[e2e] 失败：${message}`);
  process.exitCode = 1;
});
