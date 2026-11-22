/**
 * 从 CRP 导入已有提测主题的接口。
 *
 * 两条 GET 用于第一步「找主题」：
 *
 * - `?topicId=123`：按 ID 读一个主题，顺带给出它有多少个 Release；
 * - `?baselineId=<uuid>&name=<关键字>`：在某条基线（CRP 交付分支）下按名称搜 `test` 类型主题；
 * - `?baselineId=<uuid>&mine=1`：列出当前 CRP 账号在这条基线下建的全部 `test` 类型主题，
 *   不用想关键字，和 CRP 自己的「查看我的主题」一致。`mine=1` 时 `name` 可省略，也可以
 *   同时给，两个条件一起收窄。当前账号只取服务端 `GET /user` 的返回值，请求里带不进来。
 *
 * 一条 POST 同时承担「预览」与「导入」：`mode=preview` 只算不写，`mode=commit` 真正落库。
 * 两条路走的是同一个计划函数，页面看到的逐包映射就是服务端要写的东西。
 *
 * 鉴权分两层：读 CRP 主题要已登录账号（读），导入要项目所属工作区里的开发者 ——
 * 工作区从项目归属查出，不采信请求体。规则的细节在 `lib/releases/import.ts`，
 * 这里只做鉴权、参数校验与错误码翻译。请求体与返回体见 `docs/API.md`。
 */

import { NextResponse } from "next/server";

import { errorJson } from "@/lib/auth/http";
import { requireRole } from "@/lib/auth/server";
import { prisma } from "@/lib/db";
import {
  createCrpClientFromEnv,
  CrpError,
  topicOwnedBy,
  TOPIC_SEARCH_LIMIT,
  type CrpTopic,
} from "@/lib/integrations/crp";
import {
  findReleaseProjectRef,
  importReleaseFromTopic,
  previewReleaseImport,
  ReleaseError,
  ReleaseImportConflict,
} from "@/lib/releases";

export const dynamic = "force-dynamic";

/** 导入提测需要工作区里的「开发者」角色，与创建提测同一口径。 */
const REQUIRED_ROLE = "developer" as const;

/** 主题在第一步列表里显示的样子。 */
type TopicSummary = {
  id: number;
  name: string;
  branchId: number;
  branchName: string;
  owner: string;
  type: string;
  abandoned: boolean;
  completed: boolean;
  releaseCount: number;
  /** Owner 里有没有当前 CRP 账号；只按关键字搜（没解析过账号）时为 `null`。 */
  mine: boolean | null;
};

/** `ReleaseError` 的状态码 → 错误码，一处定义，预览与导入共用。 */
function releaseErrorCode(status: number): string {
  if (status === 409) {
    return "conflict";
  }

  if (status >= 500) {
    return "crp_unavailable";
  }

  return "invalid_request";
}

/** 主题所在分支的名字；库里没有这条基线时退回分支 ID。 */
async function branchNameOf(branchId: number): Promise<string> {
  const baseline = await prisma.baseline.findUnique({
    where: { crpBranchId: String(branchId) },
    select: { name: true },
  });

  return baseline?.name ?? `分支 ID ${branchId}`;
}

/**
 * 把 CRP 客户端的失败翻成响应。
 *
 * 读不到 CRP 是外部依赖的问题，用 502：让调用方知道「重试可能有用」，
 * 而不是把上游故障伪装成自己的 400。
 */
function crpFailure(error: unknown, what: string): NextResponse {
  const message = error instanceof CrpError ? error.message : "请查看服务端日志。";

  console.error(`[GET/POST /api/releases/import] ${what}失败`, error);

  return errorJson(502, "crp_unavailable", `读取 CRP 失败（${what}）：${message}`);
}

async function summarizeTopic(topic: CrpTopic, releaseCount: number): Promise<TopicSummary> {
  return {
    id: topic.id,
    name: topic.name,
    branchId: topic.branchId,
    branchName: await branchNameOf(topic.branchId),
    owner: topic.owner,
    type: topic.type,
    abandoned: topic.abandoned,
    completed: topic.completed,
    releaseCount,
    // 按 ID 读主题不解析当前账号，所以「是不是本人建的」这里不做判断。
    mine: null,
  };
}

export async function GET(request: Request) {
  // 主题与 Release 是平台级数据（基线清单同样不分工作区），已登录账号即可读。
  const guard = await requireRole({ scope: "account", role: "reader" });

  if (!guard.ok) {
    return guard.response;
  }

  const url = new URL(request.url);
  const topicIdText = (url.searchParams.get("topicId") ?? "").trim();
  const baselineId = (url.searchParams.get("baselineId") ?? "").trim();
  const name = (url.searchParams.get("name") ?? "").trim();
  // `mine=1` 是「只看我的主题」。只认 `1`，别的值一律当没给，免得 `mine=0` 之类被当成真。
  const mine = (url.searchParams.get("mine") ?? "").trim() === "1";
  const topicId = topicIdText === "" ? null : Number(topicIdText);

  // 先把两种用法分清楚，再连 CRP：参数不对不必去碰上游。
  if (topicId !== null && (!Number.isInteger(topicId) || topicId <= 0)) {
    return errorJson(400, "invalid_query", "topicId 必须是正整数。");
  }

  if (topicId === null && baselineId === "") {
    return errorJson(
      400,
      "invalid_query",
      "要么给 topicId，要么给 baselineId —— 按名称搜索与「只看我的主题」都要先选一条基线。",
    );
  }

  if (topicId === null && name === "" && !mine) {
    return errorJson(
      400,
      "invalid_query",
      "要么给 topicId，要么同时给 baselineId 与 name（按名称搜索）；只想看自己建的主题就再加 mine=1。",
    );
  }

  let crp;

  try {
    crp = createCrpClientFromEnv(process.env);
  } catch (error) {
    return crpFailure(error, "建立 CRP 客户端");
  }

  if (topicId !== null) {
    try {
      const topic = await crp.getTopic(topicId);
      const releases = await crp.listReleases(topicId);

      return NextResponse.json({ topic: await summarizeTopic(topic, releases.length) });
    } catch (error) {
      if (error instanceof CrpError) {
        return crpFailure(error, "读主题");
      }

      throw error;
    }
  }

  const baseline = await prisma.baseline.findUnique({
    where: { id: baselineId },
    select: { crpBranchId: true },
  });

  if (baseline === null) {
    return errorJson(404, "baseline_not_found", "基线不存在。");
  }

  const branchId = Number(baseline.crpBranchId);

  if (!Number.isInteger(branchId) || branchId <= 0) {
    return errorJson(409, "baseline_without_branch", "这条基线没有可用的 CRP 分支 ID，无法搜索主题。");
  }

  try {
    const { topics, total, currentUser } = await crp.searchTopics({ branchId, name, mine });
    const branchName = await branchNameOf(branchId);
    // 判断口径与列表过滤同一个函数：页面上「创建者是否本人」不能和筛选各算一套。
    const accounts =
      currentUser === null
        ? []
        : [currentUser.name, currentUser.nameCn].map((item) => item.trim()).filter((item) => item !== "");

    return NextResponse.json({
      topics: topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        branchId: topic.branchId,
        branchName,
        owner: topic.owner,
        type: topic.type,
        abandoned: topic.abandoned,
        completed: topic.completed,
        releaseCount: null,
        mine: currentUser === null ? null : topicOwnedBy(topic, accounts),
      })),
      // 截断要能让页面说清「只显示前 N 条」：`total` 是截断前的命中数。
      total,
      limit: TOPIC_SEARCH_LIMIT,
      truncated: total > topics.length,
      currentUser:
        currentUser === null ? null : { name: currentUser.name, nameCn: currentUser.nameCn },
    });
  } catch (error) {
    if (error instanceof CrpError) {
      return crpFailure(error, mine ? "读取我的主题" : "搜索主题");
    }

    throw error;
  }
}

/** 请求体：`mode` 必填，避免「本想预览却真导入了」。 */
type ImportBody = {
  projectId: string;
  topicId: number;
  mode: "preview" | "commit";
  addPackagesToProject: boolean;
};

function parseBody(body: unknown): { ok: true; value: ImportBody } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "请求体必须是 JSON 对象。" };
  }

  const raw = body as Record<string, unknown>;
  const projectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  const topicId = Number(raw.topicId);
  const mode = raw.mode;

  if (projectId === "") {
    return { ok: false, message: "必须给 projectId：提测要挂在一个项目上。" };
  }

  if (!Number.isInteger(topicId) || topicId <= 0) {
    return { ok: false, message: "必须给 topicId：CRP 主题 ID 是正整数。" };
  }

  if (mode !== "preview" && mode !== "commit") {
    return { ok: false, message: "mode 必须是 preview 或 commit。" };
  }

  return {
    ok: true,
    value: {
      projectId,
      topicId,
      mode,
      addPackagesToProject: raw.addPackagesToProject === true,
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(400, "invalid_json", "请求体不是合法 JSON。");
  }

  const parsed = parseBody(body);

  if (!parsed.ok) {
    return errorJson(400, "invalid_payload", parsed.message);
  }

  const input = parsed.value;

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

  if (input.mode === "preview") {
    try {
      const preview = await previewReleaseImport({
        projectId: input.projectId,
        topicId: input.topicId,
      });

      return NextResponse.json(preview);
    } catch (error) {
      if (error instanceof ReleaseError) {
        return errorJson(error.status, releaseErrorCode(error.status), error.message);
      }

      console.error("[POST /api/releases/import] 预览失败", error);
      return errorJson(500, "internal_error", "生成导入预览失败，请查看服务端日志。");
    }
  }

  try {
    const imported = await importReleaseFromTopic({
      projectId: input.projectId,
      topicId: input.topicId,
      createdById: guard.auth.account.id,
      addPackagesToProject: input.addPackagesToProject,
    });

    return NextResponse.json(
      {
        id: imported.releaseId,
        version: imported.version,
        revision: imported.revision,
        status: imported.status,
        source: "imported",
        packageCount: imported.packages.length,
        autoRegisteredPackages: imported.autoRegisteredPackages,
        addedToProject: imported.addedToProject,
        workProgress: imported.workProgress,
        workProgressLabel: imported.workProgressLabel,
        workProgressError: imported.workProgressError,
        locked: imported.locked,
        packages: imported.packages.map((item) => ({
          packageName: item.packageName,
          branch: item.branch,
          commitSha: item.commitSha,
          commitSource: item.commitSource,
          codeVersion: item.codeVersion,
          repoVersion: item.repoVersion,
          releaseVersion: item.releaseVersion,
          crpReleaseId: item.crpReleaseId,
          buildState: item.buildState,
          status: item.status,
          versionMismatch: item.versionMismatch,
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ReleaseImportConflict) {
      return NextResponse.json(
        {
          error: {
            code: "already_imported",
            message: error.message,
            details: {
              existingReleaseId: error.existingReleaseId,
              existingVersion: error.existingVersion,
            },
          },
        },
        { status: 409 },
      );
    }

    if (error instanceof ReleaseError) {
      return errorJson(error.status, releaseErrorCode(error.status), error.message);
    }

    console.error("[POST /api/releases/import] 导入失败", error);
    return errorJson(500, "internal_error", "导入提测失败，请查看服务端日志。");
  }
}
