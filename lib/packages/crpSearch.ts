/**
 * 「从 CRP 查项目」—— 软件包登记页当场问 CRP，结果直接回页面（MKACG-996）。
 *
 * 解决的是「登记软件包时 CRP 项目名到底叫什么，要离开平台去 CRP 网站翻」这件事。
 * 三条硬约束决定了这里的形状：
 *
 * 1. **不写库。** 这是纯查询，一行 `package` / `baseline` 都不产生，所以这里不碰 prisma。
 * 2. **按名字查，不能列全部。** CRP 的 `POST /project` 只认 `name`，`page` 被服务端忽略
 *    （翻页拿到的是同一批），`perPage` 超过 100 也还是 100 条。所以没有「列出全部」这条路。
 * 3. **名字是模糊匹配。** 查 `kwin` 会连 `dde-kwin`、`kwindowsystem` 一起返回，调用方必须
 *    自己收紧 —— 这里把「包名与关键词完全相等」的排到最前并标 `exact`，其余按名字长度升序，
 *    越接近关键词越靠前。
 *
 * 另外两件现场问题：
 *
 * - **限流**。CRP 有 429，且实测连续重发会把限流窗口拖长。所以同一关键词 60 秒内复用结果
 *   （进程内缓存），429 只往上报秒数，不在这里偷偷重试。
 * - **错误要翻成人话**。CRP 的原始报错（含英文与内部路径）不能直接给前端，这一层负责把
 *   四类失败翻成固定说法与状态码，见 `toSearchError`。
 */

import {
  createCrpClientForCurrentUser,
  CrpAuthError,
  CrpError,
  CrpNetworkError,
  CrpRateLimitedError,
  type CrpProject,
} from "../integrations/crp";

/** CRP `POST /project` 一次最多返回这么多条：实测 `perPage=500` 也仍是 100。 */
export const CRP_RESULT_CAP = 100;

/** `limit` 的默认值与上限。默认取满，`truncated` 才有意义。 */
export const SEARCH_DEFAULT_LIMIT = CRP_RESULT_CAP;
export const SEARCH_MAX_LIMIT = CRP_RESULT_CAP;

/**
 * CRP 在这个接口上忽略 `branchID`（不同分支返回的内容完全一致，实测见 FINDINGS.md）。
 * 所以默认传 0，表示「不按交付分支收窄」；调用方想传自己的分支也可以，内容不会变。
 */
export const CRP_ANY_BRANCH_ID = 0;

/** 同一关键词的结果复用多久。 */
export const SEARCH_CACHE_TTL_MS = 60_000;

/** 进程内缓存最多留多少条，超了淘汰最早写进来的那一条。 */
export const SEARCH_CACHE_CAPACITY = 200;

/** 一条查询结果：只回这几个字段，CRP 的原始对象不整包透出。 */
export type CrpProjectSearchItem = {
  /** CRP 里的项目名，例如 `kwin-qtrebuild`。登记软件包时填进「CRP 项目名」。 */
  crpProjectName: string;
  /** Debian 源码包名，例如 `kwin`。CRP 里可能为空串，不要假设它非空。 */
  packageName: string;
  /** 仓库地址，例如 `ssh://gerrit.uniontech.com:29418/dde-kwin`。 */
  repoUrl: string;
  /** `packageName` 与关键词忽略大小写后完全相等。 */
  exact: boolean;
};

/** 接口的返回体。 */
export type CrpProjectSearchResult = {
  items: CrpProjectSearchItem[];
  /** CRP 返回满 100 条：说明还有更多没拿到，提示用户收紧关键词。 */
  truncated: boolean;
  /** 实际用的关键词（已去掉首尾空白），回显给前端对账。 */
  query: string;
};

/**
 * 查询失败。`status` / `code` 直接给接口用，`message` 是给用户看的中文。
 *
 * 与 `CrpError` 分开：CRP 那边怎么错的不该由前端决定怎么显示，这一层翻完再往上抛。
 */
export class CrpProjectSearchError extends Error {
  readonly status: number;
  readonly code: string;
  /** 限流时该等多少秒；其他失败为 `null`。 */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status: number; code: string; retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = "CrpProjectSearchError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** 缓存里存的东西：排序后的结果与截断标记，关键词由调用方另行回显。 */
export type CrpProjectSearchCacheEntry = {
  items: CrpProjectSearchItem[];
  truncated: boolean;
};

/** 进程内缓存。接口只有这两个动作，测试可以换一份空的。 */
export type CrpProjectSearchCache = {
  read(key: string): CrpProjectSearchCacheEntry | null;
  write(key: string, entry: CrpProjectSearchCacheEntry): void;
  size(): number;
};

/**
 * 造一份进程内缓存。
 *
 * `Map` 的迭代顺序就是写入顺序，所以「淘汰最旧的」取第一个键即可；命中后重新写一次
 * 会让它排到最后，等同于「最近用过的留得久」。
 */
export function createSearchCache(
  options: { ttlMs?: number; capacity?: number; now?: () => number } = {},
): CrpProjectSearchCache {
  const ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS;
  const capacity = options.capacity ?? SEARCH_CACHE_CAPACITY;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { entry: CrpProjectSearchCacheEntry; expiresAt: number }>();

  return {
    read(key) {
      const found = entries.get(key);

      if (found === undefined) {
        return null;
      }

      if (found.expiresAt <= now()) {
        entries.delete(key);

        return null;
      }

      return found.entry;
    },
    write(key, entry) {
      entries.delete(key);
      entries.set(key, { entry, expiresAt: now() + ttlMs });

      while (entries.size > capacity) {
        const oldest = entries.keys().next();

        if (oldest.done === true) {
          break;
        }

        entries.delete(oldest.value);
      }
    },
    size: () => entries.size,
  };
}

/** 页面上的进程级缓存：所有请求共用一份，才有「同一关键词 60 秒内只打一次」的效果。 */
const sharedCache = createSearchCache();

/** 真正发一次 CRP 查询。抽成参数是为了单测不必连 CRP。 */
export type CrpProjectFetcher = (input: {
  name: string;
  branchId: number;
  perPage: number;
}) => Promise<CrpProject[]>;

export type CrpProjectSearchDeps = {
  /** 默认按当前登录用户的凭据查 CRP。 */
  fetchProjects?: CrpProjectFetcher;
  /** 默认用进程级缓存。缓存自己管过期时间，测试可以换一份。 */
  cache?: CrpProjectSearchCache;
};

export type CrpProjectSearchInput = {
  query: string;
  /** 最多要几条，1..100；不传取满 100。 */
  limit?: number;
  /** CRP 忽略它，默认 0。 */
  branchId?: number;
};

/** 去掉首尾空白后的关键词。内部空格保留：CRP 的名字里可能真有空格。 */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/**
 * `limit` 查询参数 → 数值。
 *
 * 不合法（不是数字、小于 1）时退回默认值，超过上限就压到 100：CRP 也只有 100 条，
 * 为一个越界的页码参数回 400 只会让前端多写一段没用的处理。
 */
export function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") {
    return SEARCH_DEFAULT_LIMIT;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value < 1) {
    return SEARCH_DEFAULT_LIMIT;
  }

  return Math.min(value, SEARCH_MAX_LIMIT);
}

/** `branchId` 查询参数 → 数值；没给或不合法就是「不按分支收窄」。 */
export function parseBranchId(raw: string | null): number {
  if (raw === null || raw.trim() === "") {
    return CRP_ANY_BRANCH_ID;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) && value > 0 ? value : CRP_ANY_BRANCH_ID;
}

/** CRP 的项目 → 返回体里的那一行。只留三个字段，原始对象不出去。 */
export function toSearchItems(
  projects: readonly CrpProject[],
  query: string,
): CrpProjectSearchItem[] {
  const wanted = normalizeQuery(query).toLowerCase();

  return projects.map((project) => {
    const crpProjectName = (project.name ?? "").trim();
    const packageName = (project.raw.PackageName ?? "").trim();

    return {
      crpProjectName,
      packageName,
      repoUrl: (project.raw.RepoUrl ?? "").trim(),
      exact: packageName.toLowerCase() === wanted,
    };
  });
}

/**
 * 完全匹配的排前面，其余按名字长度升序；长度相同按名字排，保证同样的输入永远同样的顺序
 * （否则同一份数据两次查询顺序可能不同，前端列表会跳）。
 */
export function sortSearchItems(
  items: readonly CrpProjectSearchItem[],
): CrpProjectSearchItem[] {
  return [...items].sort((left, right) => {
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1;
    }

    const byLength = left.crpProjectName.length - right.crpProjectName.length;

    return byLength !== 0
      ? byLength
      : left.crpProjectName.localeCompare(right.crpProjectName);
  });
}

/** 默认取数：按当前登录用户的凭据查 CRP。没配凭据时会在发请求之前抛 `CredentialMissingError`。 */
async function fetchFromCrp(input: {
  name: string;
  branchId: number;
  perPage: number;
}): Promise<CrpProject[]> {
  const client = await createCrpClientForCurrentUser();

  return client.searchProjects(input);
}

/**
 * 查 CRP 里的项目。
 *
 * 关键词为空时直接抛 400，**一个 CRP 请求都不发**：空名字在 CRP 侧等于「列出全部」，
 * 那是 100 条随机结果，既没有用又白烧一次限流配额。
 */
export async function searchCrpProjects(
  input: CrpProjectSearchInput,
  deps: CrpProjectSearchDeps = {},
): Promise<CrpProjectSearchResult> {
  const query = normalizeQuery(input.query);

  if (query === "") {
    throw new CrpProjectSearchError("请输入要搜索的项目名", {
      status: 400,
      code: "query_required",
    });
  }

  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const branchId = input.branchId ?? CRP_ANY_BRANCH_ID;
  const cache = deps.cache ?? sharedCache;
  const key = `${query.toLowerCase()}\u0000${limit}\u0000${branchId}`;

  const cached = cache.read(key);

  if (cached !== null) {
    return { items: cached.items, truncated: cached.truncated, query };
  }

  const fetchProjects = deps.fetchProjects ?? fetchFromCrp;
  let projects: CrpProject[];

  try {
    projects = await fetchProjects({
      name: query,
      branchId,
      perPage: Math.min(limit, CRP_RESULT_CAP),
    });
  } catch (error) {
    const mapped = toSearchError(error);

    if (mapped === null) {
      throw error;
    }

    // 原文只进服务端日志：前端看到的是翻好的那句话。
    console.error(`[crp] 查项目「${query}」失败：`, error);
    throw mapped;
  }

  const items = sortSearchItems(toSearchItems(projects, query));
  // perPage 大于 100 时 CRP 照样回 100 条，所以「拿到 100 条」就等于「还有更多」。
  const truncated = projects.length >= CRP_RESULT_CAP;

  cache.write(key, { items, truncated });

  return { items, truncated, query };
}

/**
 * CRP 的失败 → 接口能直接用的失败。返回 `null` 表示不是 CRP 的错（交回调用方，别吞异常）。
 *
 * 四种映射是固定的，理由写在 `docs/API.md` 的那张表里：
 *
 * | CRP 那边 | 这里 | 为什么 |
 * | --- | --- | --- |
 * | 429 限流 | 503 + `retryAfter` 秒数 | 只能等，且要告诉用户等多久 |
 * | 5xx（重试用尽） | 502 | 上游故障，不是这次请求的问题 |
 * | 超时 | 504 | 与「上游故障」分开，运维看一眼就知道该查链路还是查 CRP |
 * | 401/403 | 502 | 凭据是每个人自己配的，提示去「我的账号」检查 |
 */
export function toSearchError(error: unknown): CrpProjectSearchError | null {
  if (error instanceof CrpRateLimitedError) {
    const seconds = error.retryAfterSeconds;

    return new CrpProjectSearchError(
      seconds === null ? "CRP 限流，请稍后再试" : `CRP 限流，约 ${seconds} 秒后再试`,
      { status: 503, code: "crp_rate_limited", retryAfterSeconds: seconds },
    );
  }

  if (error instanceof CrpNetworkError) {
    // 没有状态码的 `CrpNetworkError` 是没拿到响应：超时与连不上都在这一类里，靠 cause 区分。
    if (error.status === undefined && isTimeoutCause(error.cause)) {
      return new CrpProjectSearchError("CRP 响应超时", { status: 504, code: "crp_timeout" });
    }

    return new CrpProjectSearchError("CRP 暂时不可用", {
      status: 502,
      code: "crp_unavailable",
    });
  }

  if (error instanceof CrpAuthError) {
    return new CrpProjectSearchError(
      "CRP 拒绝了这次查询的凭据，请到「我的账号」检查 CRP 账号后重试",
      { status: 502, code: "crp_unavailable" },
    );
  }

  if (error instanceof CrpError) {
    return new CrpProjectSearchError("CRP 暂时不可用", {
      status: 502,
      code: "crp_unavailable",
    });
  }

  return null;
}

/** `AbortSignal.timeout()` 抛的是 `name` 为 `TimeoutError` 的 DOMException。 */
function isTimeoutCause(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("name" in cause)) {
    return false;
  }

  const name = String((cause as { name: unknown }).name);

  return name === "TimeoutError" || name === "AbortError";
}
