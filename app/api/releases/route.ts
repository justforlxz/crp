/**
 * 创建提测的接口。
 *
 * 页面（`app/(app)/releases/new`）提交到这里；阻断条件、软件包清单一致性、版本号唯一
 * 全部在服务端再判一次 —— 只靠页面禁用按钮不算数，直接调接口也要被拦住。
 *
 * 鉴权走用户会话（`requireRole`，工作区里的开发者及以上），工作区从项目归属查出，
 * 不采信请求体里传来的工作区。请求体、返回体与错误码见 `docs/API.md`。
 */

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/server";
import { errorJson } from "@/lib/auth/http";
import {
  createRelease,
  findReleaseProjectRef,
  parseReleaseInput,
  ReleaseError,
  type ReleaseInput,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 提测创建需要工作区里的「开发者」角色：只读成员不能建提测。 */
const REQUIRED_ROLE = "developer" as const;

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(400, "invalid_json", "请求体不是合法 JSON。");
  }

  const parsed = parseReleaseInput(body);

  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "请求体校验未通过。",
          details: parsed.errors,
        },
      },
      { status: 400 },
    );
  }

  const input: ReleaseInput = parsed.value;

  // 工作区从项目归属查，不信任请求体：否则任何人都能把提测写到别的项目里。
  const project = await findReleaseProjectRef(input.projectId);

  if (project === null) {
    return errorJson(404, "project_not_found", "项目不存在。");
  }

  const guard = await requireRole({
    scope: "workspace",
    workspaceId: project.workspaceId,
    role: REQUIRED_ROLE,
  });

  if (!guard.ok) {
    return guard.response;
  }

  try {
    const created = await createRelease(input, { createdById: guard.auth.account.id });

    return NextResponse.json(
      {
        id: created.id,
        version: created.version,
        revision: created.revision,
        packageCount: created.snapshots.length,
        changedCount: created.summary.changed,
        summary: created.summary.summary,
        order: created.order,
        snapshots: created.snapshots.map((snapshot) => ({
          packageName: snapshot.packageName,
          attempt: snapshot.attempt,
          branch: snapshot.branch,
          commitSha: snapshot.commitSha,
          codeVersion: snapshot.codeVersion,
          repoVersion: snapshot.repoVersion,
          releaseVersion: snapshot.releaseVersion,
          changed: snapshot.changed,
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ReleaseError) {
      return errorJson(
        error.status,
        error.status === 409 ? "conflict" : "invalid_payload",
        error.message,
      );
    }

    console.error("[POST /api/releases] 创建提测失败", error);
    return errorJson(500, "internal_error", "创建提测失败，请查看服务端日志。");
  }
}
