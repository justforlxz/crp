import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createShuttleClient,
  ShuttleError,
  parseAptSourceLine,
  parseSourcesIndex,
  readShuttleEnv,
  sourcesIndexUrl,
} from "../lib/integrations/shuttle";

const REPO_INFO_JSON = JSON.stringify({
  code: 0,
  message: "get repo detail info success",
  data: {
    reponame: "eagle-1071",
    repotype: "deb",
    repoaddr: [
      {
        address: "deb http://aptly-dev.uniontech.com/pkg/eagle-1071/release unstable main",
        name: "release",
      },
      {
        address: "deb http://aptly-dev.uniontech.com/pkg/eagle-1071/commit experimental main",
        name: "commit",
      },
    ],
  },
});

const SOURCES_INDEX = `Package: kwin
Binary: kwin-wayland, kwin-x11
Version: 4:5.27.2.213-1
Directory: pool/main/k/kwin

Package: dde-dock
Version: 5.7.28.2-1

Package: incomplete
Binary: nothing
`;

type Recorded = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, { status?: number; body: string | Buffer }>) {
  const seen: Recorded[] = [];

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init });
    const route = routes[url];

    if (!route) {
      throw new Error(`未预期的请求：${url}`);
    }

    const body = route.body;
    return new Response(body as BodyInit, { status: route.status ?? 200 });
  }) as typeof fetch;

  return { impl, seen };
}

const SOURCES_URL =
  "http://aptly-dev.uniontech.com/pkg/eagle-1071/release/dists/unstable/main/source/Sources.gz";

test("解析 deb 源地址时忽略方括号选项", () => {
  assert.deepEqual(
    parseAptSourceLine(
      "deb [trusted=yes] http://pools.uniontech.com/desktop-professional eagle/1071 main contrib non-free",
    ),
    {
      url: "http://pools.uniontech.com/desktop-professional",
      dist: "eagle/1071",
      components: ["main", "contrib", "non-free"],
    },
  );
});

test("解析 deb 源地址时去掉仓库根地址末尾的斜杠", () => {
  assert.deepEqual(
    parseAptSourceLine(
      "deb [trusted=yes] http://aptly.uniontech.com/pkg/eagle-1071/release/ unstable main",
    ),
    {
      url: "http://aptly.uniontech.com/pkg/eagle-1071/release",
      dist: "unstable",
      components: ["main"],
    },
  );
});

test("不是 deb 源地址的行返回 null", () => {
  assert.equal(parseAptSourceLine("deb-src http://example.com unstable main"), null);
  assert.equal(parseAptSourceLine(""), null);
  assert.equal(parseAptSourceLine("deb http://example.com unstable"), null);
});

test("拼出源码包索引地址", () => {
  const source = parseAptSourceLine(
    "deb http://aptly-dev.uniontech.com/pkg/eagle-1071/release unstable main",
  );

  assert.ok(source);
  assert.equal(
    sourcesIndexUrl(source, "main"),
    "http://aptly-dev.uniontech.com/pkg/eagle-1071/release/dists/unstable/main/source/Sources.gz",
  );
});

test("解析 Source 索引时跳过缺少版本的段落", () => {
  assert.deepEqual(parseSourcesIndex(SOURCES_INDEX), [
    { name: "kwin", version: "4:5.27.2.213-1" },
    { name: "dde-dock", version: "5.7.28.2-1" },
  ]);
});

test("解析 Source 索引时兼容 CRLF 换行", () => {
  const text = "Package: kwin\r\nVersion: 4:5.27.2.213-1\r\n";

  assert.deepEqual(parseSourcesIndex(text), [{ name: "kwin", version: "4:5.27.2.213-1" }]);
});

test("Shuttle 配置自成一套变量，不读取 CRP 变量", () => {
  assert.deepEqual(readShuttleEnv({ CRP_TOKEN: "should-be-ignored" }), {
    baseUrl: "https://shuttle.uniontech.com/api/shuttle",
  });

  assert.deepEqual(
    readShuttleEnv({
      SHUTTLE_BASE_URL: " https://example.test/api/shuttle ",
      SHUTTLE_TOKEN: " t ",
      CRP_TOKEN: "should-be-ignored",
    }),
    { baseUrl: "https://example.test/api/shuttle", token: "t" },
  );
});

test("listBaselinePackages 走 repo/info 再读 Sources 索引，返回按名字排序的软件包", async () => {
  const { impl, seen } = fakeFetch({
    "https://shuttle.test/api/shuttle/repo/info?type=deb&reponame=eagle-1071": {
      body: REPO_INFO_JSON,
    },
    [SOURCES_URL]: { body: gzipSync(Buffer.from(SOURCES_INDEX)) },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  const packages = await client.listBaselinePackages("eagle-1071");

  assert.deepEqual(packages, [
    { name: "dde-dock", version: "5.7.28.2-1" },
    { name: "kwin", version: "4:5.27.2.213-1" },
  ]);
  assert.deepEqual(
    seen.map((item) => item.url),
    [
      "https://shuttle.test/api/shuttle/repo/info?type=deb&reponame=eagle-1071",
      SOURCES_URL,
    ],
  );
});

test("repo/info 返回业务错误时抛 ShuttleError 并带上原因", async () => {
  const { impl } = fakeFetch({
    "https://shuttle.test/api/shuttle/repo/info?type=deb&reponame=nope": {
      body: JSON.stringify({
        code: 1,
        message: "get repo detail info fail: DetailRepo: param error",
        data: null,
      }),
    },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  await assert.rejects(
    () => client.listBaselinePackages("nope"),
    (error: unknown) =>
      error instanceof ShuttleError && /DetailRepo: param error/.test(error.message),
  );
});

test("基线仓库没有 release 地址时抛 ShuttleError", async () => {
  const { impl } = fakeFetch({
    "https://shuttle.test/api/shuttle/repo/info?type=deb&reponame=eagle-1071": {
      body: JSON.stringify({ code: 0, message: "ok", data: { reponame: "eagle-1071", repoaddr: [] } }),
    },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  await assert.rejects(
    () => client.listBaselinePackages("eagle-1071"),
    (error: unknown) => error instanceof ShuttleError && /没有 release 地址/.test(error.message),
  );
});

test("索引返回 HTTP 错误时抛 ShuttleError 并带状态码", async () => {
  const { impl } = fakeFetch({
    "https://shuttle.test/api/shuttle/repo/info?type=deb&reponame=eagle-1071": {
      body: REPO_INFO_JSON,
    },
    [SOURCES_URL]: { status: 503, body: "unavailable" },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  await assert.rejects(
    () => client.listBaselinePackages("eagle-1071"),
    (error: unknown) => error instanceof ShuttleError && error.status === 503,
  );
});

test("listBuildTasks 把构建 ID 作为字符串放进 params.taskid", async () => {
  const { impl, seen } = fakeFetch({
    "https://shuttle.test/api/shuttle/task/list": {
      body: JSON.stringify({
        total: 1,
        tasks: [
          {
            key: 600157,
            pkgname: "kwin",
            pkgver: "4:6.1.57",
            reponame: "eagle-1071/abc",
            action: "release-candidate",
            status: "UPLOAD_GIVEUP",
            status_changed: "2026-11-18 18:58:43 +0800 CST",
            username: "lijunjie",
            pkgtype: "deb",
            jobs: [{ id: 822491, arch: "arm64", status: "FAILED" }],
          },
        ],
      }),
    },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  const page = await client.listBuildTasks(600157);

  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
    params: { taskid: "600157" },
    pageSize: 20,
    current: 1,
  });
  assert.equal(page.total, 1);
  assert.deepEqual(page.tasks, [
    {
      key: 600157,
      pkgname: "kwin",
      pkgver: "4:6.1.57",
      reponame: "eagle-1071/abc",
      action: "release-candidate",
      status: "UPLOAD_GIVEUP",
      statusChanged: "2026-11-18 18:58:43 +0800 CST",
      username: "lijunjie",
      pkgtype: "deb",
      jobs: [{ id: 822491, arch: "arm64", status: "FAILED" }],
    },
  ]);
});

test("listBuildTasks 不传构建 ID 时 params 为 null，用于取最新一页", async () => {
  const { impl, seen } = fakeFetch({
    "https://shuttle.test/api/shuttle/task/list": {
      body: JSON.stringify({ total: 0, tasks: null }),
    },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  const page = await client.listBuildTasks();

  assert.equal(JSON.parse(String(seen[0]?.init?.body)).params, null);
  assert.deepEqual(page, { tasks: [], total: 0 });
});

test("getJobLog 返回日志原文", async () => {
  const { impl, seen } = fakeFetch({
    "https://shuttle.test/api/shuttle/job/log?jobid=822491": {
      body: JSON.stringify({ data: "Start Build at 2026-11-18 18:19:35\n" }),
    },
  });
  const client = createShuttleClient({ baseUrl: "https://shuttle.test/api/shuttle", fetchImpl: impl });

  const result = await client.getJobLog(822491);

  assert.equal(seen[0]?.url, "https://shuttle.test/api/shuttle/job/log?jobid=822491");
  assert.deepEqual(result, { jobId: 822491, log: "Start Build at 2026-11-18 18:19:35\n" });
});

test("配置了 token 时才带 Authorization 请求头", async () => {
  const { impl, seen } = fakeFetch({
    "https://shuttle.test/api/shuttle/job/log?jobid=1": { body: JSON.stringify({ data: "" }) },
  });

  const withToken = createShuttleClient({
    baseUrl: "https://shuttle.test/api/shuttle",
    token: "abc",
    fetchImpl: impl,
  });
  await withToken.getJobLog(1);

  const withoutToken = createShuttleClient({
    baseUrl: "https://shuttle.test/api/shuttle",
    fetchImpl: impl,
  });
  await withoutToken.getJobLog(1);

  const header = (index: number) =>
    (seen[index]?.init?.headers as Record<string, string> | undefined)?.Authorization;

  assert.equal(header(0), "Bearer abc");
  assert.equal(header(1), undefined);
});

test("网络异常归一化为 ShuttleError", async () => {
  const client = createShuttleClient({
    baseUrl: "https://shuttle.test/api/shuttle",
    fetchImpl: (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.getJobLog(1),
    (error: unknown) =>
      error instanceof ShuttleError && /connect ECONNREFUSED/.test(error.message),
  );
});
