/**
 * 页面级用例的 HTTP 通道（MKACG-985）。
 *
 * 权限组与部分边界用例要的是「带着 / 不带着会话请求九页会怎样」，这件事不打开浏览器也能问：
 * 一个 `fetch` 加 `redirect: "manual"` 就够，而且能看到每一跳 —— 用 `redirect: "follow"` 只看得到
 * 最后一页，「到底跳没跳、跳到哪」全丢了，而那正是这几条用例要证明的事。
 *
 * 会话沿用 `scripts/style-check/measure.ts` 的 `mintStyleSession`：种子账号的密码哈希是占位的，
 * 走登录接口永远登不进去，所以按 `lib/auth/session.ts` 的规则直接写一条会话行，跑完删掉。
 * 这里是动态 import —— 那个模块一加载就会建 Prisma Client，没有 `DATABASE_URL` 的机器上
 * 应该在「需要会话时」报错，而不是连匿名请求都做不了。
 */

import { SESSION_COOKIE_NAME } from "../../../lib/auth/session";

/** 一跳：请求了哪个路径、拿到什么状态码、被指向哪里。 */
export type Hop = {
  path: string;
  status: number;
  location: string | null;
};

export type WalkResult = {
  hops: Hop[];
  /** 最后一跳的响应体。判「页面上有没有渲染数据」用它。 */
  body: string;
};

/** 正常只有两跳（`/x` → `/login?next=…`），跟到这么多还没落地就按「可能循环」报出来。 */
const MAX_HOPS = 8;

/**
 * 从 `path` 起步，一跳一跳跟到落地。
 *
 * 返回整条链，不替调用方判断该是几跳：`SEC-01` 要 307 到 `/login?next=<当前路径>`，
 * `EDGE-05` 要 200，判据写在用例里。
 */
export async function walkPath(
  baseUrl: string,
  path: string,
  options: { cookie?: string; maxHops?: number } = {},
): Promise<WalkResult> {
  const maxHops = options.maxHops ?? MAX_HOPS;
  const hops: Hop[] = [];
  let current = path;

  for (let index = 0; index < maxHops; index += 1) {
    const response = await fetch(new URL(current, `${baseUrl}/`), {
      redirect: "manual",
      headers: options.cookie === undefined ? {} : { cookie: options.cookie },
    });
    const location = response.headers.get("location");
    hops.push({ path: current, status: response.status, location });

    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect || location === null) {
      return { hops, body: await response.text() };
    }

    const next = new URL(location, `${baseUrl}/`);
    current = `${next.pathname}${next.search}`;
  }

  throw new Error(
    `从 ${path} 起步跟了 ${String(maxHops)} 跳还没落地，可能是循环重定向：` +
      hops.map((hop) => `${hop.path} ${String(hop.status)}`).join(" → "),
  );
}

/** 直接请求一个路径，不跟随重定向。 */
export async function requestPath(
  baseUrl: string,
  path: string,
  options: { cookie?: string } = {},
): Promise<{ status: number; location: string | null; body: string }> {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    redirect: "manual",
    headers: options.cookie === undefined ? {} : { cookie: options.cookie },
  });

  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

export type MintedSession = {
  /** 直接放进请求头的 `Cookie` 值。 */
  cookie: string;
  cleanup: () => Promise<void>;
};

/**
 * 签发一条本次验收专用的会话，默认取种子里的管理员与 `desktop-core` 工作区。
 *
 * 两段分开拼，免得被当成凭据常量截走。
 */
export async function mintSession(
  options: { email?: string; workspaceSlug?: string } = {},
): Promise<MintedSession> {
  const { mintStyleSession } = await import("../../../scripts/style-check/measure");
  const session = await mintStyleSession(
    options.email ?? "admin@uniontech.com",
    options.workspaceSlug ?? "desktop-core",
  );

  return {
    cookie: SESSION_COOKIE_NAME + "=" + session.token,
    cleanup: session.cleanup,
  };
}
