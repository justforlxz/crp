/**
 * 页面样式验收（A19）：把 18 个页面在 375 / 768 / 1280 三档宽度下逐个打开，量横向滚动。
 *
 * 只在本机跑，不进 CI：需要一个已经 `pnpm db:seed` 过的库、一个跑起来的服务，以及一个开着
 * DevTools 端口的 Chrome。
 *
 * 用法：
 *
 *   pnpm build && pnpm start &            # 或 pnpm dev，端口与实际一致
 *   node --remote-debugging-port=9222 &   # 任意 Chrome / Chromium
 *   CHROME_CDP_WS=ws://127.0.0.1:9222/devtools/browser/<id> \
 *   CRP_BASE_URL=http://127.0.0.1:3000 \
 *   VERIFY_EMAIL=you@example.com VERIFY_PASSWORD=... \
 *   pnpm tsx scripts/verify-page-layout.ts --screenshots ~/.cache/crp/page-layout
 *
 * 判定：每页 `document.scrollingElement.scrollWidth <= clientWidth`，有一页不满足就退出码 1。
 * 登录、注册两页在登录之前量，其余页面在登录之后量 —— 已登录时这两页会跳去工作台。
 *
 * 为什么直接说 CDP 而不引 puppeteer 之类的库：这一条检查只需要「改视口、打开网址、读两个数字、
 * 截图」，为此往项目里加一个几百 KB 的依赖不划算。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = (process.env.CRP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const CDP_WS = process.env.CHROME_CDP_WS ?? "";
// 这两个是**平台登录**用的账号，不是 CRP 凭据：脚本要先用平台账号登录才能量受保护页面。
// 名字里不带 CRP 前缀，避免被误当成 CRP 账号（凭据按人存放之后它们早已不是）。
const EMAIL = process.env.VERIFY_EMAIL ?? "";
const PASSWORD = process.env.VERIFY_PASSWORD ?? "";

/** 三档宽度：手机、平板竖屏、桌面。 */
const WIDTHS: ReadonlyArray<number> = [375, 768, 1280];
/** 量宽度用的视口高度；只影响是否出现纵向滚动条，不影响横向判定。 */
const VIEWPORT_HEIGHT = 900;

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
};

type CdpConnection = {
  browser: {
    send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    close: () => void;
  };
  attach: (url: string) => Promise<CdpSession>;
};

type Measurement = {
  path: string;
  width: number;
  scrollWidth: number;
  clientWidth: number;
};

/** 一页的样式探针：证明样式表真的生效，且结构上没有绕过约定。 */
type StyleProbe = {
  path: string;
  /** `body` 的背景色。 */
  bodyBackground: string;
  /** `h1` 的字号与字重。 */
  headingSize: string;
  headingWeight: string;
  /** 样式表里能不能找到色板变量，证明 `app/globals.css` 被加载了。 */
  paletteLoaded: boolean;
  /** 受保护页面必须有侧栏；登录、注册、首页占位不该有。 */
  hasSidebar: boolean;
  /** 页面外层容器（PageShell 出的 `<main class="page">`）。 */
  hasPageMain: boolean;
  /** 带内联 `style` 的元素个数，必须是 0。 */
  inlineStyleCount: number;
  /** 表格总数，以及其中没走 `.table-scroll` + `.data-table` 的个数。 */
  tableCount: number;
  unwrappedTableCount: number;
  /** 状态徽标的个数，用来证明这套样式真的被用上了。 */
  badgeCount: number;
};

let failures = 0;

function heading(text: string): void {
  console.log(`\n=== ${text} ===`);
}

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "通过" : "不通过"}：${description}`);

  if (!ok) {
    failures += 1;
  }
}

/** 一个极小的 CDP 客户端：一问一答，按 id 对上请求与响应。 */
function connect(url: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    let nextId = 0;

    const send = (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, { resolve: res, reject: rej });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });

    socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      const entry = message.id === undefined ? undefined : pending.get(message.id);

      if (entry === undefined) {
        return;
      }

      pending.delete(message.id as number);

      if (message.error !== undefined) {
        entry.reject(new Error(JSON.stringify(message.error)));
        return;
      }

      entry.resolve(message.result ?? {});
    });
    socket.addEventListener("error", () => {
      reject(new Error(`连不上 CDP：${url}`));
    });
    socket.addEventListener("open", () => {
      resolve({
        browser: { send, close: () => socket.close() },
        attach: async (targetUrl: string) => {
          const { targetId } = (await send("Target.createTarget", { url: targetUrl })) as {
            targetId: string;
          };
          const { sessionId } = (await send("Target.attachToTarget", {
            targetId,
            flatten: true,
          })) as { sessionId: string };
          const session: CdpSession = {
            send: (method, params = {}) => send(method, params, sessionId),
            close: () => void send("Target.closeTarget", { targetId }),
          };
          await session.send("Page.enable");
          await session.send("Network.enable");
          return session;
        },
      });
    });
  });
}

/** 等页面把服务端渲染的内容送回来；本地已经构建过，通常 1 秒内就稳。 */
async function settle(session: CdpSession, path: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const value = (await session.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    })) as { result?: { value?: string } };

    if (value.result?.value === "complete") {
      // `complete` 之后还要给样式表和字体一点时间，避免量到未排版的状态。
      await new Promise((resolve) => setTimeout(resolve, 300));
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`页面没在 10 秒内加载完：${path}`);
}

async function measure(session: CdpSession, path: string, width: number): Promise<Measurement> {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send("Page.navigate", { url: BASE_URL + path });
  await settle(session, path);

  const { result } = (await session.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      scrollWidth: document.scrollingElement.scrollWidth,
      clientWidth: document.scrollingElement.clientWidth,
      href: location.pathname,
    })`,
    returnByValue: true,
  })) as { result: { value: string } };
  const parsed = JSON.parse(result.value) as {
    scrollWidth: number;
    clientWidth: number;
    href: string;
  };

  if (parsed.href !== path) {
    throw new Error(`打开 ${path} 后被跳到了 ${parsed.href}，无法验证这一页`);
  }

  return { path, width, ...parsed };
}

async function probe(session: CdpSession, path: string): Promise<StyleProbe> {
  const { result } = (await session.send("Runtime.evaluate", {
    expression: `(() => {
      const body = getComputedStyle(document.body);
      const heading = document.querySelector("h1");
      const headingStyle = heading === null ? null : getComputedStyle(heading);
      const tables = [...document.querySelectorAll("table")];
      const sheets = [...document.styleSheets];
      const paletteLoaded = sheets.some((sheet) => {
        try {
          return [...sheet.cssRules].some((rule) =>
            rule.cssText.includes("--color-bg"),
          );
        } catch {
          return false;
        }
      });

      return JSON.stringify({
        bodyBackground: body.backgroundColor,
        headingSize: headingStyle === null ? "" : headingStyle.fontSize,
        headingWeight: headingStyle === null ? "" : headingStyle.fontWeight,
        paletteLoaded,
        hasSidebar: document.querySelector(".app-sidebar") !== null,
        hasPageMain: document.querySelector("main.page") !== null,
        // 排除 next-route-announcer 这类框架自己注入的自定义元素：它们不是页面代码。
        inlineStyleCount: [...document.querySelectorAll("[style]")].filter(
          (element) => !element.tagName.includes("-"),
        ).length,
        tableCount: tables.length,
        unwrappedTableCount: tables.filter(
          (table) =>
            !table.classList.contains("data-table") ||
            table.closest(".table-scroll") === null,
        ).length,
        badgeCount: document.querySelectorAll(".badge").length,
      });
    })()`,
    returnByValue: true,
  })) as { result: { value: string } };

  return { path, ...(JSON.parse(result.value) as Omit<StyleProbe, "path">) };
}

async function screenshot(session: CdpSession, path: string, dir: string): Promise<void> {
  const { data } = (await session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  })) as { data: string };
  const name = path === "/" ? "root" : path.replace(/^\//, "").replace(/\//g, "-");
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, "base64"));
}

/**
 * 切到账号能看到的第一个工作区。
 *
 * 会话里没记住工作区时，工作台只出「先选一个工作区」，量不到统计卡与数据表；切一次之后
 * 服务端页面才有内容，截图也才是要验收的那一版。
 */
async function switchWorkspace(cookie: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/auth/session`, { headers: { cookie } });
  const session = (await response.json()) as { workspaces?: Array<{ id: string }> };
  const first = session.workspaces?.[0];

  if (first === undefined) {
    throw new Error("账号没有加入任何工作区，先执行 pnpm db:seed 并给账号加成员关系");
  }

  const switched = await fetch(`${BASE_URL}/api/workspaces/${first.id}/switch`, {
    method: "POST",
    headers: { cookie },
  });

  if (!switched.ok) {
    throw new Error(`切换工作区失败（HTTP ${switched.status}）`);
  }
}

/**
 * 从列表页里抓一条真实记录的 ID，用来打开详情页与更新页。
 *
 * 只认 UUID 形状的段：列表页里还有 `/projects/new` 这种固定路径，按普通字符匹配会把它
 * 当成记录 ID，量出来的其实是新建页。
 */
async function pickId(pagePath: string, prefix: string, cookie: string): Promise<string> {
  const response = await fetch(BASE_URL + pagePath, { headers: { cookie } });
  const html = await response.text();
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const match = new RegExp(`href="${prefix}/(${uuid})`, "u").exec(html);

  if (match === null) {
    throw new Error(`${pagePath} 里找不到 ${prefix}/<id>，先执行 pnpm db:seed`);
  }

  return match[1] as string;
}

async function login(): Promise<{
  /** 直接放进 `cookie` 请求头，供脚本自己抓页面用。 */
  header: string;
  /** 逐个写进浏览器会话，供截图与量宽度用。 */
  cookies: Array<{ name: string; value: string }>;
}> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`登录失败（HTTP ${response.status}），检查 VERIFY_EMAIL / VERIFY_PASSWORD`);
  }

  const raw = response.headers.getSetCookie();

  if (raw.length === 0) {
    throw new Error("登录成功但响应里没有会话 Cookie，无法继续");
  }

  const pairs = raw.map((item) => item.split(";")[0] as string);

  return {
    header: pairs.join("; "),
    cookies: pairs.map((pair) => {
      const index = pair.indexOf("=");

      return { name: pair.slice(0, index), value: pair.slice(index + 1) };
    }),
  };
}

async function main(): Promise<void> {
  if (CDP_WS === "") {
    throw new Error("缺少 CHROME_CDP_WS，例如 ws://127.0.0.1:9222/devtools/browser/<id>");
  }

  if (EMAIL === "" || PASSWORD === "") {
    throw new Error("缺少 VERIFY_EMAIL / VERIFY_PASSWORD");
  }

  const shotsArg = process.argv.findIndex((item) => item === "--screenshots");
  const shotsDir = shotsArg === -1 ? null : (process.argv[shotsArg + 1] ?? null);

  if (shotsDir !== null) {
    mkdirSync(shotsDir, { recursive: true });
  }

  const connection = await connect(CDP_WS);
  const session = await connection.attach("about:blank");
  // 浏览器可能还留着上一次的会话；先清掉，登录与注册两页才量得到。
  await session.send("Network.clearBrowserCookies");

  // 1. 登录前能打开的三页：首页占位、登录、注册。
  heading("登录前：首页 / 登录 / 注册");
  const publicRoutes = ["/", "/login", "/register"];
  const publicMeasurements: Measurement[] = [];
  const probes: StyleProbe[] = [];

  for (const path of publicRoutes) {
    for (const width of WIDTHS) {
      publicMeasurements.push(await measure(session, path, width));
    }

    probes.push(await probe(session, path));

    if (shotsDir !== null) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await session.send("Page.navigate", { url: BASE_URL + path });
      await settle(session, path);
      await screenshot(session, path, shotsDir);
    }
  }

  // 2. 登录后：其余 15 页，含从真实记录里取 ID 的详情页。
  const cookie = await login();

  for (const item of cookie.cookies) {
    await session.send("Network.setCookie", {
      name: item.name,
      value: item.value,
      domain: new URL(BASE_URL).hostname,
      path: "/",
    });
  }

  heading("登录后：15 个业务页面");
  await switchWorkspace(cookie.header);
  const releaseId = await pickId("/releases", "/releases", cookie.header);
  const packageId = await pickId("/packages", "/packages", cookie.header);
  const projectId = await pickId("/projects", "/projects", cookie.header);

  const privateRoutes = [
    "/dashboard",
    "/projects",
    "/projects/new",
    `/projects/${projectId}`,
    "/managers",
    "/packages",
    "/packages/new",
    `/packages/${packageId}`,
    "/baselines",
    "/releases",
    "/releases/new",
    "/releases/import",
    `/releases/${releaseId}`,
    `/releases/${releaseId}/update`,
    "/queue",
    "/webhooks",
  ];
  const privateMeasurements: Measurement[] = [];

  for (const path of privateRoutes) {
    for (const width of WIDTHS) {
      privateMeasurements.push(await measure(session, path, width));
    }

    probes.push(await probe(session, path));

    if (shotsDir !== null) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await session.send("Page.navigate", { url: BASE_URL + path });
      await settle(session, path);
      await screenshot(session, path, shotsDir);
    }
  }

  session.close();
  connection.browser.close();

  // 3. 结论：一张表，一行一页一档宽度。
  const all = [...publicMeasurements, ...privateMeasurements];
  const rows = new Set(all.map((item) => item.path));

  heading("横向滚动对照（scrollWidth 应等于 clientWidth）");
  console.log(["宽度", "页面", "scrollWidth", "clientWidth", "结论"].join("\t"));

  for (const width of WIDTHS) {
    for (const path of rows) {
      const item = all.find((entry) => entry.path === path && entry.width === width);

      if (item === undefined) {
        continue;
      }

      console.log(
        [
          String(width),
          path,
          String(item.scrollWidth),
          String(item.clientWidth),
          item.scrollWidth <= item.clientWidth ? "不横滚" : "整页横滚",
        ].join("\t"),
      );
    }
  }

  heading("逐页判定");
  for (const path of rows) {
    const samples = all.filter((item) => item.path === path);
    const overflow = samples.filter((item) => item.scrollWidth > item.clientWidth);
    check(
      overflow.length === 0,
      `${path} 在 ${WIDTHS.join(" / ")} 三档都不横滚` +
        (overflow.length === 0
          ? ""
          : `（溢出：${overflow.map((item) => `${item.width}px ${item.scrollWidth}>${item.clientWidth}`).join("、")}）`),
    );
  }

  heading("配色、排版与容器（1280 宽）");
  console.log(
    ["页面", "body 背景", "h1 字号/字重", "色板", "侧栏", "页面容器", "内联 style", "表格(未包)"].join("\t"),
  );
  for (const item of probes) {
    console.log(
      [
        item.path,
        item.bodyBackground,
        `${item.headingSize}/${item.headingWeight}`,
        item.paletteLoaded ? "已加载" : "缺失",
        item.hasSidebar ? "有" : "无",
        item.hasPageMain ? "有" : "无",
        String(item.inlineStyleCount),
        `${item.tableCount}(${item.unwrappedTableCount})`,
      ].join("\t"),
    );
  }

  heading("结构判定");
  for (const item of probes) {
    check(item.paletteLoaded, `${item.path} 用上了 app/globals.css 的色板`);
    check(item.bodyBackground === "rgb(245, 246, 248)", `${item.path} body 背景是设计色板里的底色`);
    check(
      item.headingSize === "24px" && item.headingWeight === "600",
      `${item.path} 一级标题按全局排版渲染（24px / 600）`,
    );
    check(item.hasPageMain, `${item.path} 由 PageShell 出内容容器`);
    check(item.inlineStyleCount === 0, `${item.path} 没有任何内联 style 属性`);
    check(item.unwrappedTableCount === 0, `${item.path} 的所有表格都在 .table-scroll 里且带 .data-table`);
  }

  // 受保护页面要有侧栏，登录 / 注册 / 首页占位不该有。
  for (const item of probes) {
    const shouldHaveNav = !["/", "/login", "/register"].includes(item.path);
    check(
      item.hasSidebar === shouldHaveNav,
      `${item.path} ${shouldHaveNav ? "有" : "没有"}侧栏导航`,
    );
  }

  if (shotsDir !== null) {
    console.log(`\n截图写在 ${shotsDir}（每页一张，1280 宽）`);
  }

  console.log(`\n共 ${rows.size} 页 × ${WIDTHS.length} 档宽度，不通过 ${failures} 项`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
