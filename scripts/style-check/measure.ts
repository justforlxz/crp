/**
 * L2 / L3 的取样：起一个 Next 服务、签发一个样式检查专用会话、用 Playwright 逐页读计算样式与截图。
 *
 * 为什么不走登录接口：`prisma/seed.ts` 给种子账号写的是占位密码哈希（`seed-not-a-real-hash-*`），
 * 登录校验真的会算 argon2，用占位哈希永远登不进去。样式检查只需要一个「已登录、已经在某个工作区」
 * 的会话，所以按 `lib/auth/session.ts` 的规则直接写一条会话行，跑完删掉：不新增账号、不改任何
 * 页面数据，会话表也不会被越堆越多。
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

import { chromium } from "@playwright/test";

import { prisma } from "../../lib/db";
import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
  initialExpiry,
} from "../../lib/auth/session";
import type { AnchorMap, AnchorSample } from "./compare";
import { DETAIL_RELEASE, type CoveredPage } from "./pages";

export type StyleSession = {
  token: string;
  /** 会话行属于本次运行，跑完（成功或失败）都要删掉。 */
  cleanup: () => Promise<void>;
};

/** 签发一条样式检查专用会话：账号、工作区都必须是种子里已有的。 */
export async function mintStyleSession(
  email: string,
  workspaceSlug: string,
): Promise<StyleSession> {
  const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  if (account === null) {
    throw new Error(`库里没有账号 ${email}，先执行 pnpm db:seed 灌种子数据`);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    select: { id: true },
  });

  if (workspace === null) {
    throw new Error(`库里没有工作区 ${workspaceSlug}，先执行 pnpm db:seed 灌种子数据`);
  }

  const now = new Date();
  // 令牌与哈希都走 `lib/auth/session.ts` 的同一份实现：两处写法一旦分叉，这里只会表现成
  // 「被重定向到 /login」，排查成本很高。
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);

  await prisma.session.create({
    data: {
      userId: account.id,
      tokenHash,
      activeWorkspaceId: workspace.id,
      expiresAt: initialExpiry(now),
    },
  });

  return {
    token,
    cleanup: async () => {
      await prisma.session.delete({ where: { tokenHash } }).catch(() => undefined);
    },
  };
}

/** 按「项目名 + 版本」定位提测详情要覆盖的那条种子记录。 */
export async function resolveReleaseId(): Promise<string> {
  const release = await prisma.release.findFirst({
    where: {
      version: DETAIL_RELEASE.version,
      project: { name: DETAIL_RELEASE.projectName },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (release === null) {
    throw new Error(
      `库里找不到提测 ${DETAIL_RELEASE.projectName} / ${DETAIL_RELEASE.version}，先执行 pnpm db:seed`,
    );
  }

  return release.id;
}

export type StyleServer = {
  baseUrl: string;
  /** 本次运行自己起的服务要停掉；用外部已有服务时是空操作。 */
  stop: () => Promise<void>;
};

/** Next 的启动脚本。直接用 node 跑它，不依赖调用方把 `pnpm` 放进 PATH（容器里常见）。 */
const NEXT_BIN = "node_modules/next/dist/bin/next";

async function runNext(args: string[], stdio: "inherit" | "ignore"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], { stdio, env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`next ${args.join(" ")} 退出码 ${String(code)}`));
    });
  });
}

/** 端口上有没有人在监听。用来在起服务之前挡住「量到了别人的服务」这种假结果。 */
function portIsBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (busy: boolean): void => {
      socket.destroy();
      resolve(busy);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 500).unref();
  });
}

async function waitForServer(baseUrl: string, child: { stderr: string[] }): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/login`);

      if (response.status < 500) {
        return;
      }
    } catch {
      // 还没监听，继续等。
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `服务没在 60 秒内就绪：${baseUrl}\n${child.stderr.join("").slice(-2000)}`,
  );
}

/**
 * 准备一个可访问的服务。
 *
 * - `CRP_STYLE_BASE_URL` 有值：直接用外部已经跑起来的服务（改检查脚本本身时这样最快）；
 * - 否则自己 `next build` + `next start`，检查结束时停掉。
 *
 * 默认先构建：`next start` 跑的是上一次的构建产物，不重建就会量到旧代码 —— 那是「门禁绿但样式坏」
 * 的老问题换了个位置。`CRP_STYLE_SKIP_BUILD=1` 只给反复调脚本时用。
 */
export async function startStyleServer(port: number): Promise<StyleServer> {
  const external = process.env.CRP_STYLE_BASE_URL?.trim();

  if (external !== undefined && external !== "") {
    const baseUrl = external.replace(/\/$/u, "");
    await waitForServer(baseUrl, { stderr: [] });

    return { baseUrl, stop: async () => undefined };
  }

  if (process.env.CRP_STYLE_SKIP_BUILD !== "1") {
    await runNext(["build"], "inherit");
  }

  // 端口被占时 `next start` 会失败退出，但等待逻辑可能先连上那个陌生服务、把它的页面当成自己的量。
  if (await portIsBusy(port)) {
    throw new Error(
      `端口 ${port} 已经被占用：先停掉占用它的服务，或用 CRP_STYLE_PORT 指定别的端口。`,
    );
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const stderr: string[] = [];
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });

  const stopped = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });

  try {
    await waitForServer(baseUrl, { stderr });
  } catch (error) {
    child.kill("SIGKILL");
    await stopped;
    throw error;
  }

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));

      await Promise.race([stopped, timeout]);

      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    },
  };
}

/**
 * 在页面里读锚点：名字 → 按文档顺序排列的所有实例。
 *
 * 写成一个独立函数是因为它要被序列化进浏览器执行：只能引用参数，不能引用模块里的变量。
 * 几何坐标换成文档坐标（`+ scrollX/scrollY`），与滚动位置无关；小数保留两位，避免浮点尾数抖动。
 *
 * 注意：这个函数体里不能定义嵌套函数。`tsx` 会用 esbuild 的 keepNames 给函数包一层 `__name(...)`，
 * 而浏览器里没有这个标识符，`page.evaluate` 会直接报 `__name is not defined`。取整就地把
 * `Math.round(x * 100) / 100` 写出来。
 */
function collectAnchors(properties: string[]): AnchorMap {
  const anchors: AnchorMap = {};

  for (const element of document.querySelectorAll("[data-style-anchor]")) {
    const name = element.getAttribute("data-style-anchor") ?? "";

    if (name.trim() === "") {
      continue;
    }

    const computed = getComputedStyle(element);
    const style: Record<string, string> = {};

    for (const property of properties) {
      style[property] = String(
        computed[property as keyof CSSStyleDeclaration] ?? "",
      );
    }

    const rect = element.getBoundingClientRect();
    const sample: AnchorSample = {
      style: style as AnchorSample["style"],
      box: {
        x: Math.round((rect.left + window.scrollX) * 100) / 100,
        y: Math.round((rect.top + window.scrollY) * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      },
    };

    (anchors[name] ??= []).push(sample);
  }

  return anchors;
}

export type CapturedPage = {
  page: CoveredPage;
  anchors: AnchorMap;
  screenshot: Buffer;
};

/**
 * 逐页取样：打开页面 → 等字体就位 → 读锚点 → 整页截图。
 *
 * 被重定向到别的路径（最常见是会话失效被踢回 `/login`）直接报错：不然会把登录页当成业务页量进去，
 * 得到一份“看起来正常”的假基线。
 */
export async function capturePages(input: {
  baseUrl: string;
  sessionToken: string;
  pages: readonly CoveredPage[];
  viewport: { width: number; height: number };
  properties: readonly string[];
}): Promise<CapturedPage[]> {
  const { baseUrl, sessionToken, pages, viewport, properties } = input;
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: "zh-CN",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
    });

    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: sessionToken,
        url: `${baseUrl}/`,
      },
    ]);

    const captured: CapturedPage[] = [];

    for (const page of pages) {
      const tab = await context.newPage();

      try {
        const response = await tab.goto(`${baseUrl}${page.path}`, {
          waitUntil: "networkidle",
        });

        if (response !== null && response.status() >= 400) {
          throw new Error(`${page.path} 返回 HTTP ${String(response.status())}`);
        }

        const expectedPath = page.path.split("?")[0] ?? page.path;
        const landed = new URL(tab.url()).pathname;

        if (landed !== expectedPath) {
          throw new Error(
            `${page.path} 被重定向到 ${landed}，先确认会话与工作区是否可用`,
          );
        }

        // 字体没就位就量，字宽会差一点点，几何和截图都跟着抖。
        await tab.evaluate(() => document.fonts.ready.then(() => undefined));

        const anchors = await tab.evaluate(collectAnchors, [...properties]);

        // 侧栏由 layout 在每个受保护页面上挂一次，六个页面各存一份只是把一次侧栏改动
        // 的 diff 分散到六个文件里。只在保留共享锚点的那一页（工作台）入基线。
        if (!page.keepsSharedAnchors) {
          for (const name of Object.keys(anchors)) {
            if (name.startsWith("nav.") || name.startsWith("sidebar.")) {
              delete anchors[name];
            }
          }
        }

        const screenshot = await tab.screenshot({
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });

        captured.push({ page, anchors, screenshot });
      } finally {
        await tab.close();
      }
    }

    return captured;
  } finally {
    await browser.close();
  }
}
