/**
 * CRP 客户端：把登录、基线、Topic、Release、工作流这些能力组装成一个对象。
 *
 * 这里只做装配与两个简单查询（基线、当前账号），其余按主题放在同目录的模块里：
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `request.ts` | 带登录态的请求层：超时、重试、错误分类、401 续期 |
 * | `topics.ts` | 建 Topic、读主题、按名称搜主题、放弃 Topic、仓库地址 |
 * | `releases.ts` | 投递、查询、删除、重试 Release |
 * | `projects.ts` | 按软件包名解析 `ProjectID` |
 * | `workflow.ts` | `WorkProgress` 数值与标签 |
 * | `config.ts` | 环境变量、默认值、路径展开 |
 *
 * 三条贯穿全模块的约定：
 *
 * 1. 凭据只从环境变量来，token 缓存写磁盘时 0600；错误消息不含请求头。
 * 2. 错误分四类抛（网络 / 认证 / 业务拒绝 / 参数非法），见 errors.ts。
 * 3. 每个接口的真实请求与响应都记在同目录 FINDINGS.md 里。
 */

import { readCrpConfig } from "./config";
import {
  CrpBusinessError,
  CrpInvalidParameterError,
  responseSnippet,
} from "./errors";
import {
  abandonTopic,
  createTopic,
  topicUrls,
} from "./topics";
import {
  deleteRelease,
  listReleases,
  retryRelease,
  submitRelease,
} from "./releases";
import { searchProjects } from "./projects";
import { getTopic, searchTopics } from "./topics";
import {
  createCrpTransport,
  type CrpTransport,
  type CrpTransportOptions,
} from "./request";
import { normalizeTopicWorkflow } from "./workflow";
import type {
  CrpBranch,
  CrpCreateTopicInput,
  CrpCreatedTopic,
  CrpCurrentUser,
  CrpProject,
  CrpRawBranch,
  CrpRawUser,
  CrpRawWorkflowInfo,
  CrpRelease,
  CrpSubmitReleaseInput,
  CrpSubmittedRelease,
  CrpTopicUrls,
  CrpTopicUrlsInput,
  CrpTopicWorkflow,
  CrpTopic,
} from "./types";

/** 客户端的构造参数就是请求层的参数，没有额外项。 */
export type CrpClientOptions = CrpTransportOptions;

export type CrpClient = {
  /** 登录并返回 token；已有可用缓存时直接用缓存。 */
  login(): Promise<string>;
  listBranches(): Promise<CrpBranch[]>;
  getCurrentUser(): Promise<CrpCurrentUser>;
  searchProjects(input: { name: string; branchId: number }): Promise<CrpProject[]>;
  /** 读主题详情（名称、基线分支、Owner、状态）。从 CRP 导入的第一步用它。 */
  getTopic(topicId: number): Promise<CrpTopic>;
  /**
   * 按名称搜索某条交付分支下的 `test` 类型主题。
   *
   * 走 `GET /branches/{id}/topics?Type=test` 再本地按名称过滤：`POST /topics/search`
   * 在这个部署上对任何请求体都返回 `null`，实测见 FINDINGS.md 第 4.4 节。
   */
  searchTopics(input: { branchId: number; name: string }): Promise<CrpTopic[]>;
  createTopic(input: CrpCreateTopicInput): Promise<CrpCreatedTopic>;
  submitRelease(input: CrpSubmitReleaseInput): Promise<CrpSubmittedRelease>;
  listReleases(topicId: number): Promise<CrpRelease[]>;
  deleteRelease(releaseId: number): Promise<void>;
  retryRelease(releaseId: number): Promise<void>;
  topicUrls(input: CrpTopicUrlsInput): Promise<CrpTopicUrls>;
  getTopicWorkflow(topicId: number): Promise<CrpTopicWorkflow>;
  /**
   * 放弃 Topic。
   *
   * CRP 没有删除 Topic 的接口（`DELETE /api/topics/{id}` 返回 200 但什么也不做，
   * 见 FINDINGS.md），清理只能靠把 Topic 标成已放弃。
   */
  abandonTopic(topicId: number): Promise<void>;
};

/** `GET /branches` 不需要认证，实测匿名就能拿到全部交付分支。 */
async function listBranches(transport: CrpTransport): Promise<CrpBranch[]> {
  const raw = await transport.request<CrpRawBranch[]>({
    method: "GET",
    path: "/branches",
    auth: false,
  });

  if (!Array.isArray(raw)) {
    throw new CrpBusinessError("GET /branches 没有返回数组，CRP 行为与预期不符", {
      responseSnippet: responseSnippet(JSON.stringify(raw)),
    });
  }

  return raw.map((item) => ({
    id: Number(item.ID),
    name: item.Name,
    description: item.Description ?? "",
    repoType: item.RepoType ?? "",
    isCheck: item.IsCheck === 1 || item.IsCheck === true,
    raw: item,
  }));
}

async function getCurrentUser(transport: CrpTransport): Promise<CrpCurrentUser> {
  const raw = await transport.request<CrpRawUser>({ method: "GET", path: "/user" });

  return {
    name: raw?.Name?.trim() ?? "",
    nameCn: raw?.NameCN?.trim() ?? "",
    raw: raw ?? {},
  };
}

async function getTopicWorkflow(
  transport: CrpTransport,
  topicId: number,
): Promise<CrpTopicWorkflow> {
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new CrpInvalidParameterError("查工作流必须给 Topic ID：topicId 不合法");
  }

  const raw = await transport.request<CrpRawWorkflowInfo>({
    method: "GET",
    path: `/topics/${topicId}/workflow/info`,
  });

  return normalizeTopicWorkflow(topicId, raw ?? {});
}

export function createCrpClient(options: CrpClientOptions = {}): CrpClient {
  const transport = createCrpTransport(options);

  return {
    login: () => transport.login(),
    listBranches: () => listBranches(transport),
    getCurrentUser: () => getCurrentUser(transport),
    searchProjects: (input) => searchProjects(transport, input),
    getTopic: (topicId) => getTopic(transport, topicId),
    searchTopics: (input) => searchTopics(transport, input),
    createTopic: (input) =>
      createTopic(transport, input, async () => (await getCurrentUser(transport)).name),
    submitRelease: (input) => submitRelease(transport, input),
    listReleases: (topicId) => listReleases(transport, topicId),
    deleteRelease: (releaseId) => deleteRelease(transport, releaseId),
    retryRelease: (releaseId) => retryRelease(transport, releaseId),
    topicUrls: (input) => topicUrls(transport, input),
    getTopicWorkflow: (topicId) => getTopicWorkflow(transport, topicId),
    abandonTopic: (topicId) => abandonTopic(transport, topicId),
  };
}

/** 按环境变量建客户端；凭据缺失时直接抛参数错误。 */
export function createCrpClientFromEnv(
  source: Record<string, string | undefined> = process.env,
  overrides: Omit<CrpClientOptions, "baseUrl" | "username" | "password" | "tokenPath"> = {},
): CrpClient {
  const config = readCrpConfig(source);

  return createCrpClient({
    ...overrides,
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    tokenPath: config.tokenPath,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
    retries: overrides.retries ?? config.retries,
  });
}
