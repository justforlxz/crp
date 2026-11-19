/**
 * 导出这条提测的软件包提交快照为 CSV（A13）。
 *
 * 列与详情页的快照表一一对应（`SNAPSHOT_COLUMNS`，11 列，顺序一致），行就是详情页上那 N 行，
 * 顺序也一样：页面与这份文件用的是同一个取数函数与同一个铺格子的函数。
 * 导出永远只包含这一条提测的内容，不会把整个工作区的记录一起倒出来。
 *
 * 鉴权走用户会话：工作区从提测归属查出，不采信查询串里传来的工作区；提测不存在与没权限
 * 一律 404，不泄露这条提测是否存在。
 *
 * 提交说明与提交人这两列要读 Gerrit。读不到时留空，导出仍然成功 —— 一个外部系统读不到，
 * 不该让整份文件下不来。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { findReleaseScope } from "@/lib/build";
import {
  buildSnapshotCsv,
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

  return new NextResponse(buildSnapshotCsv(detail.packages), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": contentDisposition(
        `${detail.project.key}-${detail.version}-r${detail.revision}.csv`,
      ),
      "cache-control": "no-store",
    },
  });
}
