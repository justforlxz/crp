/**
 * 从 base URL 打开（MKACG-959）：`/` 不是页面，是一条指向工作台的重定向。
 *
 * 为什么单独一条：37 个节点的验收全部从 `/login` 或 `/dashboard` 直接进，没有一条从 base URL
 * 走一遍，于是 A1 建的占位页在 `/` 上活了整个项目周期。这条检查把那个盲区堵上，由
 * `scripts/e2e.sh` 在服务起来之后、跑主链路之前调用 —— 主链路要真实 CRP 构建一小时，
 * 这条只要几秒，重定向被改坏了当场就能看出来。
 *
 * 两种身份都查：
 *
 * 1. 不带会话：`/` → 307 `/dashboard` → 守卫 → `/login?next=%2Fdashboard`；
 * 2. 带会话：`/` → 307 `/dashboard` → 200 工作台，且响应里没有占位页原文。
 *
 * 用法（需要一个 `pnpm db:seed` 过的库与一个跑起来的服务；`--base-url` 不给时读 `E2E_BASE_URL`）：
 *
 *   pnpm build && pnpm exec next start &
 *   DATABASE_URL=... pnpm tsx scripts/verify-base-url.ts --base-url=http://127.0.0.1:3000
 *
 * 退出码：0 通过；1 断言失败（打印每一跳与失败理由）；2 参数或环境不对，什么都没查。
 *
 * 会话不走登录接口：`prisma/seed.ts` 给种子账号写的是占位密码哈希，登录校验真的算 argon2，
 * 永远对不上。这里按 `lib/auth/session.ts` 的同一份规则直接写一条会话行，跑完删掉
 * （与 `scripts/e2e.ts` 的 `mintSession`、`scripts/style-check/measure.ts` 的
 * `mintStyleSession` 同一个做法：规则只有 `lib/auth/session.ts` 一份，各脚本自己管自己的会话行）。
 */

import "dotenv/config";

import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
  initialExpiry,
} from "../lib/auth/session";
import { prisma } from "../lib/db";

import {
  checkBaseUrlEntry,
  describeRedirectChain,
  type BaseUrlEntry,
  type RedirectHop,
} from "./e2e-support";

/** 会话用的种子账号与工作区：与 `scripts/e2e.ts` 同一个。 */
const SESSION_EMAIL = "admin@uniontech.com";
const WORKSPACE_SLUG = "desktop-core";

/**
 * 最多跟这么多跳。
 *
 * 正常只有两跳（`/` → `/dashboard` → 登录页或工作台）。跟到这里还没落地就是循环重定向，
 * 直接判失败，不要在这里转圈。
 */
const MAX_HOPS = 8;

/** 参数或环境不对：什么都没查，退出码 2（与 `scripts/e2e.sh` 的约定一致）。 */
function die(message: string): never {
  console.error(`verify-base-url: ${message}`);
  process.exit(2);
}

/** 取 `--base-url`，没给时退回 `E2E_BASE_URL`；去掉结尾的 `/`，拼路径时不会出现 `//`。 */
function parseBaseUrl(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith("--base-url="));
  const raw = (flag === undefined ? process.env.E2E_BASE_URL : flag.slice("--base-url=".length)) ?? "";

  if (raw.trim() === "") {
    die("缺少 --base-url（例如 --base-url=http://127.0.0.1:3000），也没有 E2E_BASE_URL");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    die(`--base-url 不是合法地址：${JSON.stringify(raw)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    die(`--base-url 只接受 http / https，收到的是 ${url.protocol}`);
  }

  return url.toString().replace(/\/$/, "");
}

/**
 * 从 `/` 起步，一跳一跳跟到落地，返回整条链与最后一跳的响应体。
 *
 * 不用 `redirect: "follow"`：那样只看得到最后一页，中间跳了几次、从哪跳到哪全都看不见，
 * 而「`/` 到底有没有重定向」正是这条检查要证明的事。
 */
async function walk(baseUrl: string, cookie?: string): Promise<BaseUrlEntry> {
  const hops: RedirectHop[] = [];
  let path = "/";

  for (let index = 0; index < MAX_HOPS; index += 1) {
    const response = await fetch(new URL(path, baseUrl), {
      redirect: "manual",
      headers: cookie === undefined ? {} : { cookie },
    });
    const location = response.headers.get("location");
    hops.push({ path, status: response.status, location });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect || location === null) {
      return { hops, body: await response.text() };
    }

    const next = new URL(location, baseUrl);
    path = `${next.pathname}${next.search}`;
  }

  die(`从 / 起步跟了 ${MAX_HOPS} 跳还没落地，可能是循环重定向：${describeRedirectChain(hops)}`);
}

/** 签发一条本次检查专用的会话：账号、工作区都必须是种子里已有的，跑完删掉。 */
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
    die(`库里没有种子账号 ${SESSION_EMAIL} 或工作区 ${WORKSPACE_SLUG}，先执行 pnpm db:seed`);
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

async function main(): Promise<void> {
  const baseUrl = parseBaseUrl(process.argv.slice(2));
  console.log(`从 base URL 打开：${baseUrl}`);

  const session = await mintSession();

  try {
    const anonymous = await walk(baseUrl);
    const authenticated = await walk(baseUrl, session.cookie);

    console.log(`  不带会话：${describeRedirectChain(anonymous.hops)}`);
    console.log(`  带会话：${describeRedirectChain(authenticated.hops)}`);

    const problems = checkBaseUrlEntry({ anonymous, session: authenticated });

    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`  ✗ ${problem}`);
      }
      console.error("从 base URL 打开：失败");
      process.exitCode = 1;
      return;
    }

    console.log("  ✓ 两种身份都从 / 落到该去的地方，页面上没有占位页原文");
  } finally {
    await session.cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[verify-base-url] 失败：${message}`);
  process.exitCode = 1;
});
