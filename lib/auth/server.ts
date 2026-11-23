/**
 * 服务端守卫与 Cookie 读写。
 *
 * 所有服务端入口（Route Handler、受保护页面）都从这里拿身份，不允许各自解析 Cookie：
 *
 * - `requireRole()`：接口用。放行时给出账号、生效角色与工作区；拦下时直接返回 401/403/404 的 JSON。
 * - `requirePageAuth()`：页面用。没登录就 302 到登录页并带上回跳地址。
 * - `startSession()` / `endSession()`：登录、注册、退出登录用。
 *
 * 会话每次读取都会检查过期与撤销，并按需滑动续期；续期时顺手把 Cookie 的过期时间往后推，
 * 页面渲染阶段 Cookie 只读，写不进去就跳过（服务端过期时间仍然生效）。
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SECURE_ENV,
  generateSessionToken,
  hashSessionToken,
  initialExpiry,
  isSecureRequest,
  isSessionUsable,
  sessionCookieOptions,
  slidExpiry,
} from "./session";
import {
  decideAccountAccess,
  decideWorkspaceAccess,
  type AccountRoleRequirement,
  type Decision,
  type Role,
  type Subject,
  type WorkspaceRoleRequirement,
  unauthenticatedDecision,
} from "./roles";
import { errorJson } from "./http";
import {
  createSessionRecord,
  findMembershipRole,
  findSessionWithAccount,
  revokeSessionByTokenHash,
  updateSessionExpiry,
  type AccountRecord,
  type SessionRecord,
} from "./store";

/** 通过守卫后拿到的身份。`workspaceId` 只在工作区级要求下有值。 */
export type AuthContext = {
  account: AccountRecord;
  role: Role;
  sessionId: string;
  workspaceId: string | null;
};

/** 守卫的要求：账号级（登录即可 / 平台管理员），或工作区级（工作区内至少某个角色）。 */
export type RoleRequirement =
  | { scope: "account"; role: AccountRoleRequirement }
  | { scope: "workspace"; workspaceId: string; role: WorkspaceRoleRequirement };

/** 守卫结果。拦下时 `response` 就是要直接返回的 JSON 响应。 */
export type GuardResult = { ok: true; auth: AuthContext } | { ok: false; response: NextResponse };

/**
 * 当前请求的 Cookie 带不带 `Secure`。
 *
 * 由请求协议推导，见 `session.ts` 的 `isSecureRequest()`。不看 `NODE_ENV`：`pnpm start`
 * 下它恒为 production，而 http 部署的浏览器会直接丢掉带 `Secure` 的 Cookie，登录后立刻
 * 变回未认证。写入与清除 Cookie 都走这里，避免一处带 `Secure` 另一处不带。
 *
 * `request` 只用来取请求 URL 的协议；页面渲染阶段拿不到 `Request` 对象时省略，
 * 此时只剩 `x-forwarded-proto` 与 `SESSION_COOKIE_SECURE` 两个信号。
 */
async function secureCookies(request?: Request): Promise<boolean> {
  const requestHeaders = await headers();

  return isSecureRequest(
    request?.url ?? null,
    requestHeaders.get("x-forwarded-proto"),
    process.env[SESSION_COOKIE_SECURE_ENV],
  );
}

/** 统一的错误响应体：`code` 稳定可断言，`message` 给人看，不含任何内部细节。 */
export function errorResponse(decision: Extract<Decision, { allowed: false }>): NextResponse {
  return errorJson(decision.status, decision.code, decision.message);
}

/** 取当前会话：没有 Cookie、令牌查不到、已撤销、已过期都返回 null。 */
async function readSession(
  now: Date = new Date(),
): Promise<{ session: SessionRecord; account: AccountRecord } | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const found = await findSessionWithAccount(hashSessionToken(token));

  if (found === null || !isSessionUsable(found.session, now)) {
    return null;
  }

  const slid = slidExpiry(found.session.expiresAt, now);

  if (slid !== null) {
    await updateSessionExpiry(found.session.id, slid);

    try {
      jar.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(slid, now, await secureCookies()));
    } catch {
      // 页面渲染阶段 Cookie 只读：写不进去不影响服务端的过期时间。
    }
  }

  return { session: { ...found.session, expiresAt: slid ?? found.session.expiresAt }, account: found.account };
}

/**
 * 接口守卫。判定规则见 `roles.ts`，这里只负责把「当前请求是谁」拼出来。
 *
 * 用法：
 *
 * ```ts
 * const guard = await requireRole({ scope: "workspace", workspaceId, role: "developer" });
 * if (!guard.ok) return guard.response;
 * ```
 */
export async function requireRole(requirement: RoleRequirement): Promise<GuardResult> {
  const current = await readSession();

  if (current === null) {
    return { ok: false, response: errorResponse(unauthenticatedDecision()) };
  }

  const workspaceRole =
    requirement.scope === "workspace"
      ? await findMembershipRole(current.account.id, requirement.workspaceId)
      : null;

  const subject: Subject = {
    kind: "user",
    isPlatformAdmin: current.account.isPlatformAdmin,
    workspaceRole,
  };

  const decision =
    requirement.scope === "account"
      ? decideAccountAccess(subject, requirement.role)
      : decideWorkspaceAccess(subject, requirement.role);

  if (!decision.allowed) {
    return { ok: false, response: errorResponse(decision) };
  }

  return {
    ok: true,
    auth: {
      account: current.account,
      role: decision.role,
      sessionId: current.session.id,
      workspaceId:
        requirement.scope === "workspace" ? requirement.workspaceId : current.session.activeWorkspaceId,
    },
  };
}

/** 页面守卫：未登录跳登录页（带 `next` 回跳参数），登录了返回身份。 */
export async function requirePageAuth(nextPath: string): Promise<AuthContext> {
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  return guard.auth;
}

/** 页面上「已经登录就跳走」的判断，登录页与注册页用。 */
export async function peekSession(): Promise<AccountRecord | null> {
  const current = await readSession();
  return current?.account ?? null;
}

/** 建立会话，返回要写进 Cookie 的令牌与过期时间。库里只有令牌的哈希。 */
export async function startSession(
  accountId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = initialExpiry(now);

  await createSessionRecord({
    userId: accountId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });

  return { token, expiresAt };
}

/** 撤销当前会话。没有会话时什么也不做，重复退出登录不报错。 */
export async function endSession(now: Date = new Date()): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await revokeSessionByTokenHash(hashSessionToken(token), now);
  }
}

/** 把会话写进响应 Cookie。`request` 用来判断协议，见 `secureCookies()`。 */
export async function attachSessionCookie(
  response: NextResponse,
  session: { token: string; expiresAt: Date },
  request?: Request,
  now: Date = new Date(),
): Promise<NextResponse> {
  response.cookies.set(
    SESSION_COOKIE_NAME,
    session.token,
    sessionCookieOptions(session.expiresAt, now, await secureCookies(request)),
  );
  return response;
}

/**
 * 清掉会话 Cookie。
 *
 * 属性与写入时完全一致（同一个 `sessionCookieOptions()`），只是立即过期：
 * 一处带 `Secure` 另一处不带时，浏览器会留下一个删不掉的同名 Cookie。
 */
export async function clearSessionCookie(
  response: NextResponse,
  request?: Request,
): Promise<NextResponse> {
  response.cookies.set(
    SESSION_COOKIE_NAME,
    "",
    sessionCookieOptions(new Date(0), new Date(), await secureCookies(request)),
  );
  return response;
}
