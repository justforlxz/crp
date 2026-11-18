/**
 * Gerrit 与 gitiles 客户端。
 *
 * 两类请求走两条路：
 * - Gerrit REST（`/a/...`）读分支，响应体带 XSSI 前缀 `)]}'`。
 * - gitiles（`/plugins/gitiles/...`）读提交与 `debian/changelog`。
 *
 * 两条路都要求认证：匿名请求会被 302 重定向到登录页，所以凭据必须来自环境变量，
 * 且客户端不跟随跳转（跳转目标写成 `http://`，跟过去就是明文传参）。
 * 真实行为与实测证据见同目录 FINDINGS.md。
 */

import {
  type ChangelogEntry,
  parseChangelog,
  ChangelogParseError,
} from "./changelog";

export { type ChangelogEntry, parseChangelog, ChangelogParseError };

/** 分页上限：任何调用方要求再多，单次也只取这么多条提交。 */
export const MAX_COMMITS = 50;

const DEFAULT_BASE_URL = "https://gerrit.uniontech.com";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Gerrit REST 与 gitiles 的 JSON 响应都以这个 XSSI 前缀开头。 */
const XSSI_PREFIX = ")]}'";

/**
 * gitiles 的路径必须挂在 `/a/` 前缀下才认 Basic 认证。
 *
 * 写成 `/plugins/gitiles/...` 时，即使带了正确凭据也会被 302 到登录页；
 * 两种写法都实测过，见同目录 FINDINGS.md。
 */
const GITILES_ROOT = "/a/plugins/gitiles";

/** Gerrit 侧的错误基类：网络失败、响应异常。 */
export class GerritError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GerritError";
  }
}

/** 凭据缺失、被拒绝，或服务器把人往登录页重定向。 */
export class GerritAuthError extends GerritError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GerritAuthError";
  }
}

/** 项目、分支、提交或文件不存在。 */
export class GerritNotFoundError extends GerritError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GerritNotFoundError";
  }
}

export type GerritConfig = {
  /** Gerrit 服务地址，不带结尾斜杠。 */
  baseUrl: string;
  /** Gerrit 用户名。 */
  username: string;
  /** Gerrit Settings → HTTP Credentials 生成的 HTTP 凭据密码。 */
  httpPassword: string;
  /** 单次请求超时，毫秒。 */
  timeoutMs: number;
};

/**
 * 从环境变量读出 Gerrit 配置。
 *
 * 凭据缺失直接抛错，而不是退回匿名请求——匿名请求只会拿到登录页跳转，
 * 会把「没配置」伪装成「接口不存在」。
 */
export function readGerritConfig(
  source: Record<string, string | undefined> = process.env,
): GerritConfig {
  const username = source.GERRIT_USERNAME?.trim();
  const httpPassword = source.GERRIT_HTTP_PASSWORD?.trim();

  if (!username || !httpPassword) {
    throw new GerritError(
      "缺少 Gerrit 凭据：需要环境变量 GERRIT_USERNAME 与 GERRIT_HTTP_PASSWORD。" +
        "HTTP 凭据在 Gerrit 网页 Settings → HTTP Credentials 生成，复制到 .env 后不要提交。",
    );
  }

  const baseUrl = (source.GERRIT_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  return { baseUrl, username, httpPassword, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export type GerritBranch = {
  /** 完整 ref，如 `refs/heads/develop/eagle`。 */
  ref: string;
  /** 短分支名，如 `develop/eagle`。 */
  branch: string;
  /** 该分支当前指向的提交。 */
  revision: string;
};

export type GerritPerson = {
  name: string;
  email: string;
  /** gitiles 返回的时间原样字符串，不做时区换算。 */
  time: string;
};

export type GerritCommit = {
  sha: string;
  parents: string[];
  author: GerritPerson;
  committer: GerritPerson;
  message: string;
};

export type GerritClient = {
  /** 列出项目全部分支。 */
  listBranches(project: string): Promise<GerritBranch[]>;
  /** 列出分支上的提交，从新到旧，超过上限的部分丢掉。 */
  listCommits(
    project: string,
    branch: string,
    limit?: number,
  ): Promise<GerritCommit[]>;
  /** 读取单条提交。 */
  getCommit(project: string, sha: string): Promise<GerritCommit>;
  /** 读取指定 ref 的 `debian/changelog` 并解析首条条目，同时给出原文供复核。 */
  readChangelog(
    project: string,
    ref: string,
  ): Promise<{ entry: ChangelogEntry; text: string }>;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GerritClientOptions = {
  /** 替换 fetch，供单测注入；默认用全局 fetch。 */
  fetch?: FetchLike;
};

/** 去掉 Gerrit 与 gitiles 的 XSSI 前缀，否则 `JSON.parse` 必然失败。 */
export function stripGerritPrefix(body: string): string {
  return body.startsWith(XSSI_PREFIX) ? body.slice(XSSI_PREFIX.length) : body;
}

/**
 * 判断一个 ref 是不是提交号（完整 40 位或短的十六进制前七位以上）。
 *
 * 提交号不能补 `refs/heads/`：补了以后 gitiles 会去 `refs/heads/<提交号>` 找分支，
 * 直接 404。实测两种写法对照见 FINDINGS.md 第 2 节。
 */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function isCommitSha(ref: string): boolean {
  return COMMIT_SHA_PATTERN.test(ref);
}

/**
 * 把分支名或标签名补成完整 ref；提交号原样返回。
 *
 * gitiles 的路径里没写 `refs/heads/` 时会把 `develop/eagle` 当成一条不存在的 ref，
 * 所以分支要补前缀；但提交号一旦补前缀就指向一个不存在的分支。
 */
export function normalizeRef(ref: string): string {
  if (ref.startsWith("refs/") || isCommitSha(ref)) {
    return ref;
  }

  return `refs/heads/${ref}`;
}

/**
 * 按路径分段转义 ref，保留 `/` 作为分隔符。
 *
 * 分支名 `develop/eagle` 必须保持两段，整串转义会把斜杠变成 `%2F` 而截断路径。
 */
export function encodeGitilesRef(ref: string): string {
  return normalizeRef(ref).split("/").map(encodeURIComponent).join("/");
}

/** 项目名在 gitiles 路径里同样是多段目录。 */
function encodeGitilesPath(project: string): string {
  return project.split("/").map(encodeURIComponent).join("/");
}

type GitilesPerson = { name?: string; email?: string; time?: string };

type GitilesCommit = {
  commit?: string;
  parents?: { commit?: string }[];
  author?: GitilesPerson;
  committer?: GitilesPerson;
  message?: string;
};

function toPerson(person: GitilesPerson | undefined): GerritPerson {
  return {
    name: person?.name ?? "",
    email: person?.email ?? "",
    time: person?.time ?? "",
  };
}

function toCommit(raw: GitilesCommit, context: string): GerritCommit {
  if (!raw.commit) {
    throw new GerritError(`Gerrit 返回的提交缺少 sha：${context}`);
  }

  return {
    sha: raw.commit,
    parents: (raw.parents ?? [])
      .map((parent) => parent.commit ?? "")
      .filter((sha) => sha !== ""),
    author: toPerson(raw.author),
    committer: toPerson(raw.committer),
    message: raw.message ?? "",
  };
}

/**
 * 创建客户端。
 *
 * 请求一律带 Basic 认证、`redirect: "manual"`：Gerrit 把人往 `http://` 登录页跳时
 * 直接判定为凭据问题，而不是跟随跳转把凭据送到明文地址。
 */
export function createGerritClient(
  config: GerritConfig,
  options: GerritClientOptions = {},
): GerritClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = `Basic ${Buffer.from(
    `${config.username}:${config.httpPassword}`,
    "utf8",
  ).toString("base64")}`;

  async function request(
    path: string,
    notFoundMessage: string,
  ): Promise<string> {
    const url = new URL(path, config.baseUrl);
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: authorization, Accept: "*/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw new GerritError(`请求 Gerrit 失败：${url.pathname}`, {
        cause: error,
      });
    }

    // `redirect: "manual"` 在 undici 下给出 3xx，在其他实现下可能是 status 0 的
    // opaque redirect。两种都说明凭据没被接受。
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location") ?? "";
      throw new GerritAuthError(
        `Gerrit 未接受本次请求的凭据：${url.pathname} 返回 ${response.status}` +
          (location ? `，跳转目标 ${location}` : "") +
          "。匿名访问会被重定向到登录页，请检查 GERRIT_USERNAME 与 GERRIT_HTTP_PASSWORD。",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new GerritAuthError(
        `Gerrit 拒绝访问：${url.pathname} 返回 ${response.status}，请检查 GERRIT_USERNAME 与 GERRIT_HTTP_PASSWORD。`,
      );
    }

    if (response.status === 404) {
      throw new GerritNotFoundError(notFoundMessage);
    }

    if (!response.ok) {
      throw new GerritError(
        `Gerrit 返回异常状态 ${response.status}：${url.pathname}`,
      );
    }

    return await response.text();
  }

  async function requestJson<T>(path: string, notFoundMessage: string): Promise<T> {
    const body = await request(path, notFoundMessage);

    try {
      return JSON.parse(stripGerritPrefix(body).trim()) as T;
    } catch (error) {
      throw new GerritError(
        `Gerrit 返回的内容不是合法 JSON：${new URL(path, config.baseUrl).pathname}`,
        { cause: error },
      );
    }
  }

  return {
    async listBranches(project) {
      const body = await requestJson<{ ref?: string; revision?: string }[]>(
        `/a/projects/${encodeURIComponent(project)}/branches/`,
        `Gerrit 上找不到项目 ${project}，无法列出分支。请检查仓库路径是否拼错。`,
      );

      return (body ?? [])
        .filter((item) => typeof item.ref === "string")
        .map((item) => {
          const ref = item.ref as string;
          return {
            ref,
            branch: ref.replace(/^refs\/heads\//, ""),
            revision: item.revision ?? "",
          };
        });
    },

    async listCommits(project, branch, limit = MAX_COMMITS) {
      const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_COMMITS);
      const path =
        `${GITILES_ROOT}/${encodeGitilesPath(project)}` +
        // `n` 是 gitiles 的分页参数，按条数限制单页返回量；默认一页 100 条。
        `/+log/${encodeGitilesRef(branch)}?format=JSON&n=${capped}`;

      const body = await requestJson<{ log?: GitilesCommit[] }>(
        path,
        `项目 ${project} 上找不到分支 ${branch}，或该分支没有提交。`,
      );

      return (body.log ?? [])
        .slice(0, capped)
        .map((item) => toCommit(item, `${project}@${branch}`));
    },

    async getCommit(project, sha) {
      const path =
        `${GITILES_ROOT}/${encodeGitilesPath(project)}` +
        `/+/${encodeURIComponent(sha)}?format=JSON`;

      return toCommit(
        await requestJson<GitilesCommit>(
          path,
          `项目 ${project} 上找不到提交 ${sha}。`,
        ),
        `${project}@${sha}`,
      );
    },

    async readChangelog(project, ref) {
      const path =
        `${GITILES_ROOT}/${encodeGitilesPath(project)}` +
        `/+/${encodeGitilesRef(ref)}/debian/changelog?format=TEXT`;

      // `format=TEXT` 返回 base64 原文，没有 XSSI 前缀，不能当 JSON 处理。
      const body = await request(
        path,
        `项目 ${project} 的 ${ref} 上读不到 debian/changelog，无法读出提测版本号。` +
          "这个 ref 上没有该文件、或仓库与分支本身不存在，Gerrit 都返回 404，无法进一步区分。",
      );

      const text = Buffer.from(body, "base64").toString("utf8");

      return { entry: parseChangelog(text), text };
    },
  };
}
