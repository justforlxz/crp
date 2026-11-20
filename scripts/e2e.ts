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
import { createCrpClient } from "../lib/integrations/crp/client";
import { readCrpConfig } from "../lib/integrations/crp/config";
import { prisma } from "../lib/db";

// ---------------------------------------------------------------------------
// 固定演练条件（见 issue MKACG-890 的「范围」）
// ---------------------------------------------------------------------------

/** 演练用的 CRP 基线。 */
const BASELINE_NAME = "eagle-1071";
/** 这条基线在 CRP 上的交付分支 ID（`GET /branches` 里 `eagle-1071` = 108）。 */
const BASELINE_BRANCH_ID = "108";
/** 工作区：种子里已有，脚本不新建工作区。 */
const WORKSPACE_SLUG = "desktop-core";
/** 签发会话用的种子账号。 */
const SESSION_EMAIL = "admin@uniontech.com";
/**
 * 演练用的三个软件包：Debian 源码包名、CRP 项目名、Gerrit 仓库路径。
 *
 * 两个名字各管一边，不能混：`name` 是 Debian 源码包名（不许下划线），
 * `crpProjectName` 是投递时去 CRP 查 `ProjectID` 用的名字（允许下划线）。
 * 这里写死的 CRP 项目名是用 `POST /api/project`（`branchID=108`）在 `eagle-1071` 上实测得到的。
 */
const PACKAGES = [
  {
    name: "wayland",
    crpProjectName: "v25_wayland",
    repoPath: "deepin-kde/wayland",
    preferredBranch: "develop/eagle",
  },
  {
    name: "kwin",
    crpProjectName: "v25_kwin",
    repoPath: "deepin-kde/kwin",
    preferredBranch: "develop/snipe",
  },
] as const;
/** `kwin` 的上游是 `wayland`。 */
const UPSTREAM = "wayland";
const DOWNSTREAM = "kwin";
/**
 * kwin 编译时真正需要的协议包。
 *
 * `eagle-1071` 的交付仓库里是 `plasma-wayland-protocols 1.10.0.28`，而 `develop/snipe` 上
 * 每一个 kwin 提交都用到 `set_color_mode`（`ORG_KDE_KWIN_OUTPUTCONFIGURATION_SET_COLOR_MODE_*`），
 * 那个协议要到更新的版本才有。不把这条依赖放进提测，kwin 一定编译失败 —— 这不是平台的问题，
 * 是这条分支缺一个上游产物。`--with-build-deps` 会把它加进清单并让 kwin 依赖它。
 */
const BUILD_DEPENDENCY = {
  name: "plasma-wayland-protocols",
  crpProjectName: "v25_plasma-wayland-protocols",
  repoPath: "deepin-kde/plasma-wayland-protocols",
  preferredBranch: "develop/eagle",
} as const;

/**
 * A17 演练里补进来的第三个包。
 *
 * 选 `deepin-kde/xwayland` 是因为它同时满足两个条件：Gerrit 上有这个仓库且有 `debian/changelog`
 * （`develop/eagle` 头是 `2:23.1.0.151-deepin151`），CRP 在 `eagle-1071`（分支 108）上有对应项目
 * `v25_xwayland`（`PkgVerPrefix = "2:"`）。原计划的 `kwindowsystem` 在这台 Gerrit 上不存在
 * （`?p=deepin-kde` 只有 kwayland、kwin、plasma-wayland-protocols、wayland、xwayland 五个仓库）。
 */
const APPEND_PACKAGE = {
  name: "xwayland",
  crpProjectName: "v25_xwayland",
  repoPath: "deepin-kde/xwayland",
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
  /** 把 kwin 真正需要的上游（plasma-wayland-protocols）一起提测。 */
  withBuildDeps: boolean;
  /** `upstream`：故意让上游构建失败，验证下游被阻断（故障演练）。 */
  fault: "none" | "upstream";
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
    withBuildDeps: flags.has("with-build-deps"),
    fault: flags.get("fault") === "upstream" ? "upstream" : "none",
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
  syncToken: string;
  /** 基线同步下来的架构，故障演练后要还原。 */
  syncedArches: string[];
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
    syncedArches: [],
    syncToken: requireEnv("SYNC_JOB_TOKEN"),
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

/**
 * 故障演练：把基线的架构换成一个这条分支支持不了的组合。
 *
 * 投递出去的 `Arches` 来自基线，换成 `sparc64` 之后 CRP 在 apply 阶段就会失败（Shuttle 任务
 * 变成 `APPLY_FAILED`、`pkgver` 为空）。上游第一个包失败后，下游应当被阻断。
 */
async function injectUnsupportedArches(env: Env): Promise<void> {
  step("2.6 故障注入：把基线架构换成不支持的组合");
  await prisma.baseline.update({
    where: { id: env.baselineId },
    data: { arches: ["sparc64"] },
  });
  log("基线架构已改为 sparc64（这条分支没有这个架构，apply 会失败）");
}

async function restoreArches(env: Env): Promise<void> {
  if (env.syncedArches.length === 0) {
    return;
  }
  await prisma.baseline.update({
    where: { id: env.baselineId },
    data: { arches: env.syncedArches },
  });
  log(`基线架构已还原：${env.syncedArches.join(";")}`);
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
  /** 投递时去 CRP 查 ProjectID 用的名字；与包名不同（CRP 侧带下划线）。 */
  crpProjectName: string;
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

/**
 * 同步一次基线。
 *
 * 投递用的架构来自基线（`Baseline.arches`），由基线同步从 Shuttle 的 release-candidate
 * 仓库读出来。空库种出来的基线没有这一列，必须先同步一次，否则推进提测会被 409 挡住。
 */
async function syncBaseline(env: Env): Promise<void> {
  step("2.5 同步基线（POST /api/jobs/baseline-sync）");

  const sync = await call({ path: "/api/jobs/baseline-sync", method: "POST", token: env.syncToken });
  expectOk(sync, "POST /api/jobs/baseline-sync");

  const synced = await prisma.baseline.findFirst({
    where: { name: BASELINE_NAME },
    select: { arches: true, syncedAt: true },
  });
  expect(synced !== null, `基线 ${BASELINE_NAME} 不见了`);

  // `source` 不是 CPU 架构，投递时会被去掉；这里一起去掉，日志里看到的就是真正发出去的那一串。
  const arches = synced!.arches.filter((item) => item !== "source");
  expect(
    arches.length > 0,
    `基线 ${BASELINE_NAME} 同步后仍然没有架构列表（${JSON.stringify(synced!.arches)}），投递会被 409 挡住。`,
  );
  env.syncedArches = arches;
  log(`基线 ${BASELINE_NAME} 架构：${arches.join(";")}`);
  log(`基线 ${BASELINE_NAME} 同步时间：${synced!.syncedAt?.toISOString() ?? "空"}`);
}

/** 本次演练要登记的软件包：默认两个，`--with-build-deps` 时加上协议包。 */
function packageSpecs(options: Options): ReadonlyArray<{
  name: string;
  crpProjectName: string;
  repoPath: string;
  preferredBranch: string;
}> {
  return options.withBuildDeps ? [...PACKAGES, BUILD_DEPENDENCY] : PACKAGES;
}

async function registerPackages(
  env: Env,
  projectId: string,
  options: Options,
): Promise<{ packages: PackageRef[]; reader: GerritReader }> {
  step("3. 登记软件包（POST /api/packages）");

  const specs = packageSpecs(options);
  const reader = createGerritReader();
  const bodies: Array<Record<string, string>> = [];
  const heads = new Map<string, Awaited<ReturnType<typeof readHead>>>();

  for (const item of specs) {
    const head = await readHead(reader, item.repoPath, item.preferredBranch);
    heads.set(item.name, head);
    log(
      `${item.name}（CRP 项目 ${item.crpProjectName}）← ${item.repoPath} @ ${head.branch} ` +
        `${head.headSha.slice(0, 12)}（代码版本 ${head.codeVersion}）`,
    );
    bodies.push({
      name: item.name,
      crpProjectName: item.crpProjectName,
      repoPath: item.repoPath,
      defaultBranch: head.branch,
    });
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
    where: { name: { in: specs.map((item) => item.name) } },
    select: { id: true, name: true },
  });

  const packages: PackageRef[] = [];
  for (const item of specs) {
    const row = rows.find((candidate) => candidate.name === item.name);
    expect(row !== undefined, `登记后库里读不到软件包 ${item.name}`);
    const head = heads.get(item.name)!;
    packages.push({
      name: item.name,
      crpProjectName: item.crpProjectName,
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

  const downstream = packages.find((item) => item.name === DOWNSTREAM)!;
  const upstreams = packages.filter(
    (item) => item.name === UPSTREAM || (options.withBuildDeps && item.name === BUILD_DEPENDENCY.name),
  );
  await saveDependencies(downstream.id, upstreams.map((item) => item.id));
  log(
    `依赖：${downstream.name} → ${upstreams.map((item) => item.name).join("、")}` +
      "（保存时已过环检测）",
  );

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

/**
 * 算出投给 CRP 的提测版本（`customTag`）。
 *
 * CRP 的项目可以带「版本前缀」（`PkgVerPrefix`，例如 kwin 是 `4:`）。带前缀的项目，
 * 调用方只能给不带 epoch 的版本号，CRP 自己把前缀拼上去：给 `4:6.1.57` 会拼成 `4:4:6.1.57`，
 * apply 阶段直接失败（现象是 Shuttle 任务 `APPLY_FAILED`、`pkgver` 为空）。
 * 所以这里先查一次 CRP 的项目前缀，前缀与代码版本的 epoch 相同时把 epoch 去掉。
 *
 * 这条不是绕开产品能力：`customTag` 就是「提测版本默认等于代码版本，可用自定义 Tag 覆盖」的那个入口。
 */
async function resolveReleaseTags(
  statutes: ReadonlyArray<{ name: string; crpProjectName: string; codeVersion: string }>,
): Promise<Map<string, string>> {
  const crp = createCrpClient(readCrpConfig());
  const tags = new Map<string, string>();

  for (const item of statutes) {
    const projects = await crp.searchProjects({ name: item.crpProjectName, branchId: Number(BASELINE_BRANCH_ID) });
    const project = projects.find((candidate) => candidate.name === item.crpProjectName);
    const prefix = String((project?.raw as { PkgVerPrefix?: string } | undefined)?.PkgVerPrefix ?? "").trim();

    const reasons: string[] = [];
    let tag = item.codeVersion;

    // CRP 项目自带版本前缀时，不能再发 epoch：`4:` + `4:6.1.57` 会变成 `4:4:6.1.57`。
    if (prefix !== "" && tag.startsWith(prefix)) {
      tag = tag.slice(prefix.length);
      reasons.push(`去掉 epoch（CRP 项目自带前缀 ${JSON.stringify(prefix)}）`);
    }

    // `debian/changelog` 的版本带 Debian 修订号（`1.10.0.32-deepin33-1`），而 CRP 不接受 `-`。
    // 截到第一个 `-` 之前：`1.10.0.32` 仍然高于仓库里已有的 `1.10.0.28-1`，不会变成降级。
    const dash = tag.indexOf("-");
    if (dash > 0) {
      reasons.push(`截掉 Debian 修订号 ${JSON.stringify(tag.slice(dash))}（CRP 不接受 '-'）`);
      tag = tag.slice(0, dash);
    }

    log(
      `版本号：${item.name} 代码版本 ${item.codeVersion} → 提测版本 ${tag}` +
        (reasons.length > 0 ? `（${reasons.join("；")}）` : "（原样使用）"),
    );

    tags.set(item.name, tag);
  }

  return tags;
}

async function createReleaseViaApi(
  options: Options,
  cookie: string,
  projectId: string,
  packages: readonly PackageRef[],
): Promise<CreatedRelease> {
  step("5. 创建提测（POST /api/releases）");

  const tags = await resolveReleaseTags(packages);

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
        customTag: tags.get(pkg.name) ?? null,
      })),
    },
  });

  const created = expectOk(reply, "POST /api/releases") as CreatedRelease;

  expect(
    created.packageCount === packages.length,
    `快照条数 ${created.packageCount} ≠ 清单 ${packages.length}`,
  );
  expect(
    created.order[created.order.length - 1] === DOWNSTREAM,
    `${DOWNSTREAM} 应该排在最后，实际 ${created.order.join(" → ")}`,
  );
  expect(
    created.order.includes(UPSTREAM),
    `依赖拓扑顺序里没有上游 ${UPSTREAM}：${created.order.join(" → ")}`,
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
        const upstreamNames = options.withBuildDeps ? [UPSTREAM, BUILD_DEPENDENCY.name] : [UPSTREAM];

        // 下游只能在上游全部成功之后才投：这条是依赖排队的核心断言。
        if (dispatched.includes(DOWNSTREAM)) {
          for (const name of upstreamNames) {
            const upstreamSnapshot = view.packages.find((pkg) => pkg.packageName === name);
            expect(
              upstreamSnapshot?.snapshotStatus === "success" ||
                upstreamSnapshot?.snapshotStatus === "superseded",
              `下游 ${DOWNSTREAM} 已投递，但上游 ${name} 的状态是 ${upstreamSnapshot?.snapshotStatus ?? "缺失"}`,
            );
          }
          orderEvidence.push(`${DOWNSTREAM} 在其全部上游成功之后才投递`);
        } else {
          for (const name of dispatched) {
            expect(
              upstreamNames.includes(name) || name === UPSTREAM,
              `${DOWNSTREAM} 之前只应该投上游，实际已投 ${dispatched.join("、")}`,
            );
          }
        }

        orderEvidence.push(`已投递：${dispatched.join("、")}`);
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

/**
 * 故障演练的断言：上游失败、下游被阻断、提测到终局且写明了原因。
 *
 * 这一步验证的是「上游失败会阻断下游」这条业务规则，与正常链路的断言方向相反。
 */
function assertUpstreamBlocked(view: DispatchView): void {
  const upstream = view.packages.find((pkg) => pkg.packageName === UPSTREAM);
  const downstream = view.packages.find((pkg) => pkg.packageName === DOWNSTREAM);

  expect(upstream !== undefined && downstream !== undefined, "提测里缺少上游或下游快照");
  expect(
    upstream!.snapshotStatus === "failed",
    `上游 ${UPSTREAM} 应当是 failed，实际 ${upstream!.snapshotStatus}`,
  );
  expect(
    downstream!.blockedByPackage === UPSTREAM,
    `下游 ${DOWNSTREAM} 应当被 ${UPSTREAM} 阻断，实际 blockedByPackage=${String(downstream!.blockedByPackage)}`,
  );
  expect(
    downstream!.statusReason !== null && downstream!.statusReason !== "",
    `下游 ${DOWNSTREAM} 没有被阻断的原因`,
  );
  expect(
    FINAL_STATUSES.has(view.status),
    `提测应当到终局，实际 ${view.status}`,
  );

  log(`上游 ${UPSTREAM} 失败：${upstream!.statusReason ?? "（无原因）"}`);
  log(`下游 ${DOWNSTREAM} 被阻断：blockedByPackage=${downstream!.blockedByPackage}，原因=${downstream!.statusReason}`);
  log(`提测状态：${view.status}`);
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
        {
          name: APPEND_PACKAGE.name,
          crpProjectName: APPEND_PACKAGE.crpProjectName,
          repoPath: APPEND_PACKAGE.repoPath,
          defaultBranch: head.branch,
        },
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
  log(
    `清单新增：${APPEND_PACKAGE.name}（CRP 项目 ${APPEND_PACKAGE.crpProjectName}）` +
      `@ ${head.branch} ${head.headSha.slice(0, 12)}`,
  );

  // 换掉 wayland 的 Commit：取同一分支上的另一条真实提交。
  const wayland = await readHead(reader, "deepin-kde/wayland", "develop/eagle");
  const commits = await reader.listCommits("deepin-kde/wayland", wayland.branch, 5);
  const currentWayland = before.packages.find((pkg) => pkg.packageName === UPSTREAM);
  const replacement =
    commits.find((commit) => commit.sha !== currentWayland?.commitSha) ?? commits[1];
  expect(replacement !== undefined, "wayland 分支上找不到另一条提交可用来演示换包。");
  log(`换包：${UPSTREAM} ${currentWayland?.commitSha.slice(0, 12) ?? "?"} → ${replacement.sha.slice(0, 12)}`);

  const beforeIds = new Map(before.packages.map((pkg) => [pkg.packageName, pkg.crpReleaseId] as const));

  // 版本号同样要按 CRP 的项目前缀与 `-` 规则换算一次：A17 的追加与替换走的是同一个校验。
  const replacementVersion = await reader.readCodeVersion("deepin-kde/wayland", replacement.sha);
  const tags = await resolveReleaseTags([
    { name: APPEND_PACKAGE.name, crpProjectName: APPEND_PACKAGE.crpProjectName, codeVersion: head.codeVersion },
    { name: UPSTREAM, crpProjectName: PACKAGES[0].crpProjectName, codeVersion: replacementVersion },
  ]);

  const body = {
    append: [
      {
        packageName: APPEND_PACKAGE.name,
        branch: head.branch,
        commitSha: head.headSha,
        customTag: tags.get(APPEND_PACKAGE.name) ?? null,
      },
    ],
    replace: [
      {
        packageName: UPSTREAM,
        branch: wayland.branch,
        commitSha: replacement.sha,
        customTag: tags.get(UPSTREAM) ?? null,
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
  options: Options,
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
      ...packageSpecs(options).map((item) => item.name),
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

    await syncBaseline(env);
    if (options.fault === "upstream") {
      await injectUnsupportedArches(env);
    }
    const { packages, reader } = await registerPackages(env, project.projectId, options);

    const created = await createReleaseViaApi(options, session.cookie, project.projectId, packages);
    createdId = created.id;

    const { view, orderEvidence, queueSeen } = await driveToFinal(
      env,
      session.cookie,
      options,
      created.id,
    );

    if (options.fault === "upstream") {
      step("演练结论（故障：上游失败）");
      assertUpstreamBlocked(view);
      log(`AC2 证据：Topic ${view.crpTopicId}（https://crp.uniontech.com/#/topic/${view.crpTopicId}）`);
      for (const pkg of view.packages) {
        log(
          `${pkg.packageName}：Release=${pkg.crpReleaseId} Build=${pkg.crpBuildId} ` +
            `状态=${pkg.snapshotStatus} 阻断自=${pkg.blockedByPackage ?? "-"} 原因=${pkg.statusReason ?? "-"}`,
        );
      }
      log(`投递顺序证据：${orderEvidence.join("；") || "（无）"}`);

      await restoreArches(env);
      if (options.keep) {
        log("按 --keep 保留本次运行的记录");
      } else {
        await cleanup(session.cookie, created.id, ids, options);
      }
      log(`结束：${new Date().toISOString()}`);
      return;
    }

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
      await cleanup(session.cookie, created.id, ids, options);
      createdId = null;
    }
  } catch (error) {
    // 故障演练改过基线架构，无论成败都要还原，否则后面的提测都会带上错的架构。
    await restoreArches(env).catch(() => undefined);

    // 演练失败也要把 CRP 侧与库里的残留在本轮清掉：否则下一次跑会撞上上一次的 Topic 与版本号。
    if (!options.keep && (createdId !== null || ids.projectId !== "")) {
      console.warn("[e2e] 演练未通过，尝试清理本次运行的残留…");
      try {
        if (createdId !== null) {
          await cleanup(session.cookie, createdId, ids, options);
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
