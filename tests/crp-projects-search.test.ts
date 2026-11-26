/**
 * 「从 CRP 查项目」的领域逻辑（MKACG-996）。
 *
 * 锁住的是 issue 里那张验收表里能在源码层断言的部分：空关键词不发请求、`exact` 只认
 * `packageName` 完全相等、一分钟内同一关键词只打一次 CRP、CRP 返回满 100 条才算截断、
 * 四类失败翻成固定状态码与中文。
 *
 * 两件事这里不做，交给预览环境的验收：
 *
 * - 真的发一次未登录请求要起服务（C-5 的运行时部分）；
 * - 查库行数前后对比要连库（C-6 的运行时部分）。
 *
 * 这两条的源码前提在这里用扫描文件的方式锁住：接口必须过会话守卫，且这条路径上不能有
 * 任何数据库入口 —— 没有入口就不可能写出 `package` 行。
 *
 * 样本用的是 CRP 上的真实数据（2026-11-25 实测）：查 `kwin` 返回 `dde-kwin`（包名同名）、
 * `kwindowsystem`（`PackageName` 是空串）与 `kwin-qtrebuild`（`PackageName` 是 `kwin`）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CrpAuthError,
  CrpBusinessError,
  CrpNetworkError,
  CrpRateLimitedError,
  type CrpProject,
} from "../lib/integrations/crp";
import {
  createSearchCache,
  CRP_RESULT_CAP,
  CrpProjectSearchError,
  normalizeQuery,
  parseBranchId,
  parseLimit,
  SEARCH_CACHE_TTL_MS,
  SEARCH_DEFAULT_LIMIT,
  searchCrpProjects,
  sortSearchItems,
  toSearchError,
  toSearchItems,
} from "../lib/packages/crpSearch";
import { repoPathFromRepoUrl } from "../lib/packages/repoUrl";

const ROUTE_PATH = join(process.cwd(), "app", "api", "crp", "projects", "route.ts");
const SEARCH_PATH = join(process.cwd(), "lib", "packages", "crpSearch.ts");

/** 造一条 CRP 项目，字段名用 CRP 自己的写法（`raw` 里是原样响应）。 */
function project(raw: { name: string; packageName?: string; repoUrl?: string }): CrpProject {
  return {
    id: 1,
    name: raw.name,
    raw: {
      ID: 1,
      Name: raw.name,
      PackageName: raw.packageName ?? null,
      RepoUrl: raw.repoUrl ?? null,
    },
  };
}

const KWIN_RESULT: CrpProject[] = [
  project({
    name: "dde-kwin",
    packageName: "dde-kwin",
    repoUrl: "ssh://gerrit.uniontech.com:29418/dde-kwin",
  }),
  project({
    name: "kwindowsystem",
    packageName: "",
    repoUrl: "https://gitlabwh.uniontech.com/wuhan/linuxdeepin-debian/kwindowsystem",
  }),
  project({
    name: "kwin-qtrebuild",
    packageName: "kwin",
    repoUrl: "ssh://git@gitlabwh.uniontech.com/wuhan/kelvinu-porting/kwin-5.15.5.5.git",
  }),
];

/** 一次查询用的依赖：干净的缓存 + 记下每次 CRP 调用的假取数。 */
function fakeDeps(projects: CrpProject[] = KWIN_RESULT) {
  const calls: Array<{ name: string; branchId: number; perPage: number }> = [];

  return {
    calls,
    deps: {
      cache: createSearchCache(),
      fetchProjects: async (input: { name: string; branchId: number; perPage: number }) => {
        calls.push(input);

        return projects;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// C-1：空关键词 → 400，且一个 CRP 请求都不发
// ---------------------------------------------------------------------------

test("空关键词直接 400 query_required，CRP 请求计数为 0", async () => {
  const { calls, deps } = fakeDeps();

  await assert.rejects(
    () => searchCrpProjects({ query: "   " }, deps),
    (error: unknown) => {
      assert.ok(error instanceof CrpProjectSearchError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "query_required");
      assert.equal(error.message, "请输入要搜索的项目名");

      return true;
    },
  );

  assert.equal(calls.length, 0, "空关键词不该向 CRP 发请求");
});

test("关键词去掉首尾空白，内部空格保留", () => {
  assert.equal(normalizeQuery("  kwin  "), "kwin");
  assert.equal(normalizeQuery("dde kwin"), "dde kwin");
  assert.equal(normalizeQuery("\n\t "), "");
});

// ---------------------------------------------------------------------------
// C-2：模糊匹配里 exact 只认 packageName，且排最前
// ---------------------------------------------------------------------------

test("exact 只认 packageName 完全相等，并排在最前；其余按名字长度升序", async () => {
  const { deps } = fakeDeps();
  const result = await searchCrpProjects({ query: "kwin" }, deps);

  assert.deepEqual(
    result.items.map((item) => item.crpProjectName),
    ["kwin-qtrebuild", "dde-kwin", "kwindowsystem"],
  );
  assert.deepEqual(
    result.items.map((item) => item.exact),
    [true, false, false],
  );
  assert.equal(result.query, "kwin");
});

test("packageName 为空串时原样返回空串，不当成与项目名相同", () => {
  const items = toSearchItems(
    [
      project({ name: "kwindowsystem", packageName: "" }),
      project({ name: "kwin-qtrebuild", packageName: "kwin" }),
    ],
    "kwin",
  );

  assert.equal(items[0]?.packageName, "");
  assert.equal(items[0]?.exact, false);
  assert.equal(items[1]?.exact, true);
});

test("exact 忽略大小写；repoUrl 原样带出", () => {
  const items = toSearchItems(
    [project({ name: "v25_kwin", packageName: "KWin", repoUrl: "ssh://gerrit/foo" })],
    "kwin",
  );

  assert.equal(items[0]?.exact, true);
  assert.equal(items[0]?.repoUrl, "ssh://gerrit/foo");
});

test("名字长度相同时按名字排，同样的输入永远同样的顺序", () => {
  const sorted = sortSearchItems([
    { crpProjectName: "bbb", packageName: "", repoUrl: "", exact: false },
    { crpProjectName: "aaa", packageName: "", repoUrl: "", exact: false },
    { crpProjectName: "exact", packageName: "exact", repoUrl: "", exact: true },
  ]);

  assert.deepEqual(
    sorted.map((item) => item.crpProjectName),
    ["exact", "aaa", "bbb"],
  );
});

// ---------------------------------------------------------------------------
// C-4：60 秒内同一关键词只打一次 CRP
// ---------------------------------------------------------------------------

test("60 秒内同一关键词连查三次只发一次 CRP 请求，过期后重新查", async () => {
  let clock = 1_000_000;
  const cache = createSearchCache({ now: () => clock });
  const calls: string[] = [];

  const deps = {
    cache,
    fetchProjects: async (input: { name: string }) => {
      calls.push(input.name);

      return KWIN_RESULT;
    },
  };

  await searchCrpProjects({ query: "kwin" }, deps);
  await searchCrpProjects({ query: " kwin " }, deps);
  await searchCrpProjects({ query: "KWIN" }, deps);

  assert.equal(calls.length, 1, "三次查询应只打一次 CRP");

  clock += SEARCH_CACHE_TTL_MS;
  await searchCrpProjects({ query: "kwin" }, deps);

  assert.equal(calls.length, 2, "过了 60 秒应重新查");
});

test("缓存最多 200 条，超了淘汰最早写进来的那条", () => {
  const cache = createSearchCache({ capacity: 2 });

  cache.write("a", { items: [], truncated: false });
  cache.write("b", { items: [], truncated: false });
  cache.write("c", { items: [], truncated: false });

  assert.equal(cache.size(), 2);
  assert.equal(cache.read("a"), null);
  assert.notEqual(cache.read("b"), null);
  assert.notEqual(cache.read("c"), null);
});

test("不同 limit / branchId 各自一条缓存，结果不串", async () => {
  const { calls, deps } = fakeDeps();

  await searchCrpProjects({ query: "kwin", limit: 10 }, deps);
  await searchCrpProjects({ query: "kwin", limit: 20 }, deps);
  await searchCrpProjects({ query: "kwin", limit: 20, branchId: 108 }, deps);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.perPage),
    [10, 20, 20],
  );
});

// ---------------------------------------------------------------------------
// limit / branchId 解析
// ---------------------------------------------------------------------------

test("limit 不合法时退回默认值，超过 100 压到 100", () => {
  assert.equal(parseLimit(null), SEARCH_DEFAULT_LIMIT);
  assert.equal(parseLimit(""), SEARCH_DEFAULT_LIMIT);
  assert.equal(parseLimit("abc"), SEARCH_DEFAULT_LIMIT);
  assert.equal(parseLimit("0"), SEARCH_DEFAULT_LIMIT);
  assert.equal(parseLimit("-5"), SEARCH_DEFAULT_LIMIT);
  assert.equal(parseLimit("20"), 20);
  assert.equal(parseLimit("500"), CRP_RESULT_CAP);
});

test("branchId 没给或不合法时是 0（CRP 忽略这个参数）", () => {
  assert.equal(parseBranchId(null), 0);
  assert.equal(parseBranchId(""), 0);
  assert.equal(parseBranchId("x"), 0);
  assert.equal(parseBranchId("0"), 0);
  assert.equal(parseBranchId("108"), 108);
});

test("perPage 取 limit 与 100 的较小值", async () => {
  const { calls, deps } = fakeDeps();

  await searchCrpProjects({ query: "a", limit: 100 }, deps);

  assert.equal(calls[0]?.perPage, 100);
  assert.equal(calls[0]?.branchId, 0);
});

// ---------------------------------------------------------------------------
// truncated：CRP 返回满 100 条
// ---------------------------------------------------------------------------

test("CRP 返回满 100 条时 truncated 为真", async () => {
  const many = Array.from({ length: CRP_RESULT_CAP }, (_, index) =>
    project({ name: `pkg-${String(index).padStart(3, "0")}`, packageName: "kwin" }),
  );
  const { deps } = fakeDeps(many);
  const result = await searchCrpProjects({ query: "kwin" }, deps);

  assert.equal(result.items.length, CRP_RESULT_CAP);
  assert.equal(result.truncated, true);
});

test("不到 100 条时 truncated 为假", async () => {
  const { deps } = fakeDeps();
  const result = await searchCrpProjects({ query: "kwin" }, deps);

  assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// C-3 与其余错误映射
// ---------------------------------------------------------------------------

test("CRP 429 → 503 + retryAfter 秒数，消息是中文且不含 CRP 原文", async () => {
  const deps = {
    cache: createSearchCache(),
    fetchProjects: async () => {
      throw new CrpRateLimitedError(
        "POST /project 失败（HTTP 429）：CRP 限流，请稍后重试（Retry-After: 42）",
        { status: 429, responseSnippet: '{"message":"too many requests"}', retryAfterSeconds: 42 },
      );
    },
  };

  await assert.rejects(
    () => searchCrpProjects({ query: "kwin" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof CrpProjectSearchError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "crp_rate_limited");
      assert.equal(error.retryAfterSeconds, 42);
      assert.equal(error.message, "CRP 限流，约 42 秒后再试");
      assert.ok(!error.message.includes("too many requests"), "不该出现 CRP 原文");
      assert.ok(!error.message.includes("POST /project"), "不该出现 CRP 的接口路径");

      return true;
    },
  );
});

test("CRP 没给 Retry-After 时，限流消息不编造秒数", async () => {
  const deps = {
    cache: createSearchCache(),
    fetchProjects: async () => {
      throw new CrpRateLimitedError("429", { status: 429 });
    },
  };

  await assert.rejects(
    () => searchCrpProjects({ query: "kwin" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof CrpProjectSearchError);
      assert.equal(error.retryAfterSeconds, null);
      assert.equal(error.message, "CRP 限流，请稍后再试");

      return true;
    },
  );
});

test("CRP 5xx → 502 CRP 暂时不可用", async () => {
  const deps = {
    cache: createSearchCache(),
    fetchProjects: async () => {
      throw new CrpNetworkError("POST /project 失败（HTTP 502）", {
        status: 502,
        responseSnippet: "bad gateway",
      });
    },
  };

  await assert.rejects(
    () => searchCrpProjects({ query: "kwin" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof CrpProjectSearchError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "crp_unavailable");
      assert.equal(error.message, "CRP 暂时不可用");

      return true;
    },
  );
});

test("超时 → 504 CRP 响应超时", async () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const deps = {
    cache: createSearchCache(),
    fetchProjects: async () => {
      throw new CrpNetworkError("POST /project 请求失败：30000 毫秒内没有响应，已超时", {
        cause: timeout,
      });
    },
  };

  await assert.rejects(
    () => searchCrpProjects({ query: "kwin" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof CrpProjectSearchError);
      assert.equal(error.status, 504);
      assert.equal(error.code, "crp_timeout");
      assert.equal(error.message, "CRP 响应超时");

      return true;
    },
  );
});

test("连不上也归成 502，不冒充超时", () => {
  const mapped = toSearchError(
    new CrpNetworkError("connect ECONNREFUSED", { cause: new Error("connect ECONNREFUSED") }),
  );

  assert.equal(mapped?.status, 502);
});

test("CRP 拒绝了凭据 → 502，提示去「我的账号」检查", () => {
  const mapped = toSearchError(new CrpAuthError("401", { status: 401 }));

  assert.equal(mapped?.status, 502);
  assert.match(mapped?.message ?? "", /我的账号/);
});

test("CRP 的业务拒绝也翻成 502，不带 CRP 原文", () => {
  const mapped = toSearchError(
    new CrpBusinessError("POST /project 失败：内部路径 /srv/crp 不存在", {
      status: 400,
      responseSnippet: "内部路径 /srv/crp 不存在",
    }),
  );

  assert.equal(mapped?.status, 502);
  assert.ok(!(mapped?.message ?? "").includes("内部路径"));
});

test("不是 CRP 的错就原样抛回，不吞异常", async () => {
  const deps = {
    cache: createSearchCache(),
    fetchProjects: async () => {
      throw new Error("真的不是 CRP 的错");
    },
  };

  await assert.rejects(
    () => searchCrpProjects({ query: "kwin" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof CrpProjectSearchError, false);
      assert.equal(error.message, "真的不是 CRP 的错");

      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// C-5 / C-6：接口必须过会话守卫，且这条路径上没有任何数据库入口
// ---------------------------------------------------------------------------

/** 这些 import 是仓库里唯一能碰到数据库或 prisma 客户端的入口。 */
const DB_IMPORT =
  /from\s+"(?:@\/lib\/db|(?:\.\.\/)+db|@prisma\/client|(?:\.\.\/)+generated\/prisma\/client)"/;

test("接口有会话守卫：未登录直接返回守卫的响应", () => {
  const source = readFileSync(ROUTE_PATH, "utf8");

  assert.match(source, /requireRole\(\{\s*scope:\s*"account",\s*role:\s*"reader"\s*\}\)/);
  assert.match(source, /if \(!guard\.ok\)[\s\S]{0,120}return guard\.response;/);
});

test("接口与查询链路都不碰数据库（C-6 的源码前提）", () => {
  for (const path of [ROUTE_PATH, SEARCH_PATH]) {
    const source = readFileSync(path, "utf8");

    assert.equal(DB_IMPORT.test(source), false, `${path} 不该有数据库入口`);
  }
});

// ---------------------------------------------------------------------------
// 仓库地址 → 仓库路径（C-7 预填的第三个字段）
// ---------------------------------------------------------------------------

test("Gerrit 的 SSH 地址取出仓库路径", () => {
  assert.equal(
    repoPathFromRepoUrl("ssh://gerrit.uniontech.com:29418/dde-kwin"),
    "dde-kwin",
  );
  assert.equal(
    repoPathFromRepoUrl("ssh://git@gitlabwh.uniontech.com/wuhan/kelvinu-porting/kwin.git"),
    "wuhan/kelvinu-porting/kwin",
  );
});

test("HTTP 地址取出去掉 .git 的路径；scp 写法也认", () => {
  assert.equal(
    repoPathFromRepoUrl("https://gitlabwh.uniontech.com/wuhan/linuxdeepin-debian/kwindowsystem"),
    "wuhan/linuxdeepin-debian/kwindowsystem",
  );
  assert.equal(repoPathFromRepoUrl("git@gerrit.uniontech.com:deepin-kde/kwin"), "deepin-kde/kwin");
});

test("取不出合格路径时返回空串，不往表单里塞一段保存不了的值", () => {
  assert.equal(repoPathFromRepoUrl(""), "");
  assert.equal(repoPathFromRepoUrl("   "), "");
  assert.equal(repoPathFromRepoUrl("不是地址"), "");
  assert.equal(repoPathFromRepoUrl("https://gerrit.uniontech.com/"), "");
});
