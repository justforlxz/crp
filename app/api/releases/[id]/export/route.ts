/**
 * 导出这条提测的软件包快照明细（A13；MKACG-1011 按 `design.md` 第九节改成明细）。
 *
 * 每包一行，7 列：软件包、分支、Commit、代码版本、CRP 仓库版本、架构、结果 —— 与
 * `SNAPSHOT_DETAIL_COLUMNS` 同源，也与提测单（`buildSnapshotCsv` 的 11 列）共用「软件包 / 分支 /
 * 代码版本 / Commit」四格的铺法，同一个包在两份文件里的写法不会分叉。
 *
 * 架构与结果来自 `loadReleaseBuildStatus`：这是详情页构建状态区块同一份读取，所以导出的
 * 「结果」与页面上看到的一致，不是另算一套。
 *
 * 导出永远只包含这一条提测的内容，不会把整个工作区的记录一起倒出来。
 *
 * 鉴权走用户会话：工作区从提测归属查出，不采信查询串里传来的工作区；提测不存在与没权限
 * 一律 404，不泄露这条提测是否存在。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findReleaseScope, loadReleaseBuildStatus } from "@/lib/build";
import {
  buildSnapshotDetailCsv,
  loadReleaseDetail,
  ReleaseError,
  type ReleaseDetail,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 只读成员就能导出：这与详情页的可见范围一致。 */
const EXPORT_ROLE = "reader" as const;

/** 文件名里的版本号可能带 `+`、`~` 这类字符，用引号包起来再补一个 RFC 5987 的写法。 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const scope = await findReleaseScope(id);

  if (scope === null) {
    return errorJson(404, "release_not_found", "提测记录不存在。");
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: scope.workspaceId,
    role: EXPORT_ROLE,
  });

  if (!guard.ok) {
    return guard.response;
  }

  let detail: ReleaseDetail;

  try {
    detail = await loadReleaseDetail(id);
  } catch (error) {
    if (error instanceof ReleaseError) {
      return errorJson(error.status, "release_not_found", error.message);
    }

    throw error;
  }

  // 构建状态读不到（提测记录刚被删）不该让整份文件下不来：架构与结果那两列留破折号，其余照常。
  const buildStatus = await loadReleaseBuildStatus(id);

  return new NextResponse(
    buildSnapshotDetailCsv({
      packages: detail.packages,
      repositoryRecords: detail.repositoryRecords,
      tasks: buildStatus?.tasks ?? [],
    }),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": contentDisposition(
          `${detail.project.key}-${detail.version}-r${detail.revision}-snapshots.csv`,
        ),
        "cache-control": "no-store",
      },
    },
  );
}
