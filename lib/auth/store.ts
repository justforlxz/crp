/**
 * 账号与会话的数据库读写。
 *
 * 这一层只做「取一条、写一条」，权限判定放在 `roles.ts`，Cookie 与 HTTP 语义放在 `server.ts`。
 * 所有对外的返回值都经过 `select` 挑字段：`password_hash` 只在登录校验那一条查询里出现，
 * 不会顺着别的查询漏到上层。
 */
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../db";
import type { Role, WorkspaceRoleName } from "./roles";

/** 对外的账号形态，不含 `password_hash`。 */
export type AccountRecord = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
};

/** 会话行里判定要用到的字段。 */
export type SessionRecord = {
  id: string;
  userId: string;
  activeWorkspaceId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

const ACCOUNT_SELECT = {
  id: true,
  email: true,
  displayName: true,
  isPlatformAdmin: true,
} as const;

const SESSION_SELECT = {
  id: true,
  userId: true,
  activeWorkspaceId: true,
  expiresAt: true,
  revokedAt: true,
} as const;

/** 按邮箱查账号（对外形态）。 */
export async function findAccountByEmail(email: string): Promise<AccountRecord | null> {
  return prisma.user.findUnique({ where: { email }, select: ACCOUNT_SELECT });
}

/** 登录用：一次取出账号与用于校验的哈希。只有登录路径调用。 */
export async function findLoginCandidate(
  email: string,
): Promise<{ account: AccountRecord; passwordHash: string } | null> {
  const row = await prisma.user.findUnique({
    where: { email },
    select: { ...ACCOUNT_SELECT, passwordHash: true },
  });

  if (row === null) {
    return null;
  }

  const { passwordHash, ...account } = row;
  return { account, passwordHash };
}

/** 唯一索引冲突（P2002）：邮箱、成员关系重复时用它把冲突翻译成 409。 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** 建账号。邮箱唯一，重复会抛 Prisma 的 P2002。 */
export async function createAccount(input: {
  email: string;
  displayName: string;
  passwordHash: string;
}): Promise<AccountRecord> {
  return prisma.user.create({ data: input, select: ACCOUNT_SELECT });
}

/** 写一条会话。 */
export async function createSessionRecord(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<SessionRecord> {
  return prisma.session.create({ data: input, select: SESSION_SELECT });
}

/** 按令牌哈希取会话与它所属的账号；过期与撤销与否由调用方判定。 */
export async function findSessionWithAccount(
  tokenHash: string,
): Promise<{ session: SessionRecord; account: AccountRecord } | null> {
  const row = await prisma.session.findUnique({
    where: { tokenHash },
    select: { ...SESSION_SELECT, user: { select: ACCOUNT_SELECT } },
  });

  if (row === null) {
    return null;
  }

  const { user, ...session } = row;
  return { session, account: user };
}

/** 顺延会话过期时间。 */
export async function updateSessionExpiry(sessionId: string, expiresAt: Date): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { expiresAt } });
}

/** 撤销会话：置撤销时间，行留着。按令牌哈希定位，未知令牌什么也不做。 */
export async function revokeSessionByTokenHash(tokenHash: string, now: Date): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: now },
  });
}

/** 切换当前工作区。 */
export async function setActiveWorkspace(
  sessionId: string,
  workspaceId: string | null,
): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { activeWorkspaceId: workspaceId } });
}

/** 查某个账号在某个工作区里的角色；没有成员关系时返回 null。 */
export async function findMembershipRole(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRoleName | null> {
  const row = await prisma.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  return row?.role ?? null;
}

/** 建成员关系。已有关系会抛 Prisma 的 P2002。 */
export async function addMembership(input: {
  userId: string;
  workspaceId: string;
  role: WorkspaceRoleName;
}): Promise<void> {
  await prisma.membership.create({ data: input });
}

/** 工作区对外形态。 */
export type WorkspaceRecord = { id: string; slug: string; name: string };

/** 列出账号能看到的工作区与各自角色。平台管理员看到全部，角色一律 platform_admin。 */
export async function listWorkspacesForAccount(
  userId: string,
  isPlatformAdmin: boolean,
): Promise<Array<WorkspaceRecord & { role: Role }>> {
  if (isPlatformAdmin) {
    const workspaces = await prisma.workspace.findMany({
      select: { id: true, slug: true, name: true },
      orderBy: { name: "asc" },
    });

    return workspaces.map((workspace) => ({ ...workspace, role: "platform_admin" as Role }));
  }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, slug: true, name: true } } },
    orderBy: { workspace: { name: "asc" } },
  });

  return memberships.map(({ role, workspace }) => ({ ...workspace, role }));
}

/** 按 ID 取工作区，仅用于把会话里的工作区展示出来。 */
export async function findWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
  return prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, name: true },
  });
}

/** 工作区内的项目清单（不含软删）。 */
export async function listWorkspaceProjects(
  workspaceId: string,
): Promise<Array<{ id: string; key: string; name: string }>> {
  return prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, key: true, name: true },
    orderBy: { name: "asc" },
  });
}
