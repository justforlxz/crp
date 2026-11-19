/**
 * CRP 调用记录器的落库实现。
 *
 * 设计契约 MUST：「每次对 CRP 的调用都有请求记录（URL、耗时、状态、响应摘要）可查」。
 * 记录的时机在请求层（`lib/integrations/crp/request.ts` 的 `onRequest`），不是在各处调用点上，
 * 这样重试、登录、404 一次都不会漏。
 *
 * 归属两列：
 *
 * - `releaseId`：这条记录属于哪一次提测，创建记录器时就定下来。
 * - `snapshotId`：这条记录服务于哪个软件包。建 Topic 之类的动作没有具体包，为空；
 *   投递某个包时由 `scopeToSnapshot()` 临时指定。
 *
 * 为什么用可变字段而不是给每个包建一个客户端：投递是串行的（MUST NOT 并发），
 * 同一时刻只有一个包在投递，一个指针就够，比给每个包装配一个客户端简单得多。
 */

import { prisma } from "../db";
import {
  responseSnippet,
  type CrpRequestObserver,
} from "../integrations/crp";

export type CrpCallRecorder = {
  /** 交给 CRP 客户端的观察者。 */
  observe: CrpRequestObserver;
  /** 之后发生的调用记到这个软件包上；传 `null` 恢复成只记在提测上。 */
  scopeToSnapshot(snapshotId: string | null): void;
};

/**
 * 为一条提测建一个调用记录器。
 *
 * 记录写不进去只打进程日志，不打断投递：调用记录是旁证，不能因为它写失败就把投递搞挂。
 */
export function createCrpCallRecorder(releaseId: string): CrpCallRecorder {
  let snapshotId: string | null = null;

  return {
    scopeToSnapshot(next) {
      snapshotId = next;
    },
    observe: async (observation) => {
      const snippet = responseSnippet(observation.responseSnippet ?? "");

      await prisma.crpCallLog.create({
        data: {
          releaseId,
          snapshotId,
          method: observation.method,
          url: observation.url,
          statusCode: observation.statusCode,
          durationMs: observation.durationMs,
          responseSnippet: snippet === "" ? null : snippet,
        },
      });
    },
  };
}

/** 一条提测的调用记录，页面与接口直接展示。 */
export type CrpCallLogRow = {
  id: string;
  createdAt: Date;
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number;
  responseSnippet: string | null;
  /** 这次调用服务于哪个软件包；建 Topic、放弃 Topic 之类为空。 */
  packageName: string | null;
};

/** 查一条提测最近的调用记录，按时间从新到旧。 */
export async function listCrpCallLogs(
  releaseId: string,
  limit = 50,
): Promise<CrpCallLogRow[]> {
  const rows = await prisma.crpCallLog.findMany({
    where: { releaseId },
    // 同一毫秒内可能有多条，按主键再排一次，时间线才不会乱序。
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      createdAt: true,
      method: true,
      url: true,
      statusCode: true,
      durationMs: true,
      responseSnippet: true,
      snapshotId: true,
    },
  });

  const snapshotIds = [
    ...new Set(rows.map((row) => row.snapshotId).filter((id): id is string => id !== null)),
  ];

  const names =
    snapshotIds.length === 0
      ? []
      : await prisma.releasePackageSnapshot.findMany({
          where: { id: { in: snapshotIds } },
          select: { id: true, packageName: true },
        });

  const nameById = new Map(names.map((item) => [item.id, item.packageName]));

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    method: row.method,
    url: row.url,
    statusCode: row.statusCode,
    durationMs: row.durationMs,
    responseSnippet: row.responseSnippet,
    packageName: row.snapshotId === null ? null : (nameById.get(row.snapshotId) ?? null),
  }));
}
