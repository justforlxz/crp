/**
 * Shuttle 客户端：基线仓库软件包版本、构建任务与构建日志。
 *
 * 只做「调用 + 返回结构化数据」，不写数据库，不触发构建。
 *
 * `listBaselinePackages` 的取数路径是两步，两步都有真实响应为证（见 FINDINGS.md）：
 *
 * 1. `GET /repo/info?type=deb&reponame=<基线>` 拿到该基线仓库的 apt 源地址，
 *    其中 `name` 为 `release` 的那条是稳定仓库。
 * 2. 按源地址去取 `dists/<dist>/<component>/source/Sources.gz` 并解析。
 *
 * Shuttle 没有「按基线列出全部软件包」的接口，所以版本号直接从 Shuttle 自己
 * 发布的 apt 索引里读。一次基线的请求数是「1 + 组件数」，组件实测只有 1 个，
 * 合计 2 次请求。
 */

import { gunzipSync } from "node:zlib";

import { parseAptSourceLine, parseSourcesIndex, sourcesIndexUrl } from "./debIndex";
import { SHUTTLE_DEFAULT_BASE_URL } from "./config";
import type {
  BaselinePackage,
  ShuttleBuildTask,
  ShuttleBuildTaskPage,
  ShuttleJob,
  ShuttleJobLog,
  ShuttleRepoInfo,
} from "./types";

/** 里程碑仓库的地址名，取 `release` 表示稳定仓库。 */
const RELEASE_ADDRESS_NAME = "release";

/** `repo/info` 只认 `deb` 类型。 */
const DEB_REPO_TYPE = "deb";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 20;

/** Shuttle 返回的业务错误或网络错误，带上下文便于排查。 */
export class ShuttleError extends Error {
  readonly status?: number;
  readonly responseSnippet?: string;

  constructor(message: string, options: { status?: number; responseSnippet?: string } = {}) {
    super(message);
    this.name = "ShuttleError";
    this.status = options.status;
    this.responseSnippet = options.responseSnippet;
  }
}

export type ShuttleClientOptions = {
  /** 接口前缀，默认 `https://shuttle.uniontech.com/api/shuttle`。 */
  baseUrl?: string;
  /** 可选的 Bearer token；当前读取接口不需要。 */
  token?: string;
  /** 注入用，便于测试替换网络层。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ShuttleClient = {
  listBaselinePackages(baseline: string): Promise<BaselinePackage[]>;
  getRepoInfo(baseline: string): Promise<ShuttleRepoInfo>;
  /** 不传 `buildId` 表示不加过滤，按最近构建取第一页。 */
  listBuildTasks(
    buildId?: number | string,
    page?: { current?: number; pageSize?: number },
  ): Promise<ShuttleBuildTaskPage>;
  getJobLog(jobId: number | string): Promise<ShuttleJobLog>;
};

type ShuttleEnvelope = {
  code?: number;
  message?: string;
  data?: unknown;
};

export function createShuttleClient(options: ShuttleClientOptions = {}): ShuttleClient {
  const baseUrl = (options.baseUrl ?? SHUTTLE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function headers(json: boolean): Record<string, string> {
    const result: Record<string, string> = {};

    if (json) {
      result["Content-Type"] = "application/json";
    }

    if (options.token) {
      result.Authorization = `Bearer ${options.token}`;
    }

    return result;
  }

  async function request(path: string, init: RequestInit): Promise<ShuttleEnvelope> {
    const url = `${baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ShuttleError(
        `请求 Shuttle 失败：${init.method ?? "GET"} ${url}：${(error as Error).message}`,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new ShuttleError(
        `Shuttle 返回 HTTP ${response.status}：${init.method ?? "GET"} ${url}`,
        { status: response.status, responseSnippet: text.slice(0, 500) },
      );
    }

    try {
      return JSON.parse(text) as ShuttleEnvelope;
    } catch {
      throw new ShuttleError(`Shuttle 返回的不是 JSON：${url}`, {
        status: response.status,
        responseSnippet: text.slice(0, 500),
      });
    }
  }

  /** Shuttle 有的接口用 `code` 字段表达业务结果，`0` 才是成功。 */
  function assertOk(envelope: ShuttleEnvelope, url: string): void {
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      throw new ShuttleError(
        `Shuttle 业务拒绝：${url}：${envelope.message ?? "未给出原因"}`,
        { responseSnippet: JSON.stringify(envelope).slice(0, 500) },
      );
    }
  }

  async function getRepoInfo(baseline: string): Promise<ShuttleRepoInfo> {
    const path = `/repo/info?type=${DEB_REPO_TYPE}&reponame=${encodeURIComponent(baseline)}`;
    const envelope = await request(path, { method: "GET", headers: headers(false) });
    assertOk(envelope, path);

    const data = envelope.data as
      | { reponame?: string; repotype?: string; repoaddr?: Array<{ name?: string; address?: string }> }
      | undefined;

    return {
      reponame: data?.reponame ?? baseline,
      repotype: data?.repotype ?? DEB_REPO_TYPE,
      addresses: (data?.repoaddr ?? [])
        .filter((item): item is { name: string; address: string } =>
          Boolean(item?.name && item?.address),
        )
        .map((item) => ({ name: item.name, address: item.address })),
    };
  }

  async function downloadSourcesIndex(url: string): Promise<BaselinePackage[]> {
    let response: Response;

    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ShuttleError(`下载软件包索引失败：${url}：${(error as Error).message}`);
    }

    if (!response.ok) {
      throw new ShuttleError(`软件包索引返回 HTTP ${response.status}：${url}`, {
        status: response.status,
      });
    }

    const compressed = Buffer.from(await response.arrayBuffer());

    try {
      return parseSourcesIndex(gunzipSync(compressed).toString("utf8"));
    } catch (error) {
      throw new ShuttleError(`软件包索引不是有效的 gzip：${url}：${(error as Error).message}`);
    }
  }

  async function listBaselinePackages(baseline: string): Promise<BaselinePackage[]> {
    const info = await getRepoInfo(baseline);
    const release = info.addresses.find((item) => item.name === RELEASE_ADDRESS_NAME);

    if (!release) {
      throw new ShuttleError(
        `基线 ${baseline} 的仓库信息里没有 ${RELEASE_ADDRESS_NAME} 地址，无法读取软件包版本`,
      );
    }

    const source = parseAptSourceLine(release.address);

    if (!source) {
      throw new ShuttleError(
        `基线 ${baseline} 的 ${RELEASE_ADDRESS_NAME} 地址无法解析：${release.address}`,
      );
    }

    const merged = new Map<string, string>();

    for (const component of source.components) {
      for (const item of await downloadSourcesIndex(sourcesIndexUrl(source, component))) {
        // 同一个软件包出现在多个组件里时，保留先出现的版本。
        if (!merged.has(item.name)) {
          merged.set(item.name, item.version);
        }
      }
    }

    return [...merged.entries()]
      .map(([name, version]) => ({ name, version }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function listBuildTasks(
    buildId?: number | string,
    page: { current?: number; pageSize?: number } = {},
  ): Promise<ShuttleBuildTaskPage> {
    // taskid 必须是字符串，传数字会查不到任何任务（实测 total 为 0）。
    const body = {
      params: buildId === undefined ? null : { taskid: String(buildId) },
      pageSize: page.pageSize ?? DEFAULT_PAGE_SIZE,
      current: page.current ?? 1,
    };
    const path = "/task/list";
    const envelope = await request(path, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
    });
    assertOk(envelope, path);

    // `task/list` 把 `tasks` 与 `total` 放在最外层，不走 `data` 包装。
    const flat = envelope as { tasks?: unknown; total?: number };
    const data = envelope.data as { tasks?: unknown; total?: number } | undefined;
    const rawTasks = (flat.tasks ?? data?.tasks) as
      | Array<Record<string, unknown>>
      | null
      | undefined;
    const total = flat.total ?? data?.total;

    return {
      tasks: (rawTasks ?? []).map(toBuildTask),
      total: typeof total === "number" ? total : 0,
    };
  }

  async function getJobLog(jobId: number | string): Promise<ShuttleJobLog> {
    const path = `/job/log?jobid=${encodeURIComponent(String(jobId))}`;
    const envelope = await request(path, { method: "GET", headers: headers(false) });
    assertOk(envelope, path);

    const data = envelope.data as { data?: string } | string | undefined;
    const log =
      typeof data === "string" ? data : typeof data?.data === "string" ? data.data : "";

    return { jobId: Number(jobId), log };
  }

  return { listBaselinePackages, getRepoInfo, listBuildTasks, getJobLog };
}

function toBuildTask(raw: Record<string, unknown>): ShuttleBuildTask {
  const jobs = Array.isArray(raw.jobs) ? (raw.jobs as Array<Record<string, unknown>>) : [];

  return {
    key: Number(raw.key ?? 0),
    pkgname: String(raw.pkgname ?? ""),
    pkgver: String(raw.pkgver ?? ""),
    reponame: String(raw.reponame ?? ""),
    action: String(raw.action ?? ""),
    status: String(raw.status ?? ""),
    statusChanged: String(raw.status_changed ?? ""),
    username: String(raw.username ?? ""),
    pkgtype: String(raw.pkgtype ?? ""),
    jobs: jobs.map(toJob),
  };
}

function toJob(raw: Record<string, unknown>): ShuttleJob {
  return {
    id: Number(raw.id ?? 0),
    arch: String(raw.arch ?? ""),
    status: String(raw.status ?? ""),
  };
}
