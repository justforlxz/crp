import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCrpClient } from "../lib/integrations/crp/client";
import {
  CrpAuthError,
  CrpBusinessError,
  CrpInvalidParameterError,
  CrpNetworkError,
  CrpRateLimitedError,
} from "../lib/integrations/crp/errors";

const TEST_TOKEN = "test.jwt.token";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** 按 (方法 路径) 匹配的假网络层，未匹配到的调用直接失败。 */
function makeFetch(routes: Array<[string, () => Response | Promise<Response>] | [string, Response]> ) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, headers, body });

    for (const [match, handler] of routes) {
      const [matchMethod, matchPath] = match.split(" ");
      if (matchMethod === method && url.endsWith(matchPath)) {
        return typeof handler === "function" ? await handler() : handler;
      }
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockClient(routes: Array<[string, () => Response | Promise<Response>] | [string, Response]>) {
  const { fetchImpl, calls } = makeFetch(routes);
  const sleeps: number[] = [];
  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  return { client, calls, sleeps };
}

test("取基线不带 Authorization，解析出 ID、名称与检查标记", async () => {
  const { client, calls } = mockClient([
    [
      "GET /branches",
      json([
        { ID: 108, Name: "eagle-1071", Description: "eagle-1071", RepoType: "deb", IsCheck: 1 },
        { ID: 3, Name: "elephant-stable", RepoType: "", IsCheck: 0 },
      ]),
    ],
  ]);

  const branches = await client.listBranches();

  assert.equal(calls[0]?.headers.Authorization, undefined);
  assert.deepEqual(
    branches.map((item) => ({ id: item.id, name: item.name, isCheck: item.isCheck })),
    [
      { id: 108, name: "eagle-1071", isCheck: true },
      { id: 3, name: "elephant-stable", isCheck: false },
    ],
  );
});

test("登录把密码加密后 POST 到 /login，token 落到 0600 缓存并被后续请求使用", async () => {
  const dir = mkdtempSync(join(homedir(), ".cache", "crp-tests", "client-"));
  const tokenPath = join(dir, "jwt");
  try {
    const calls: Call[] = [];
    const withLogin = createCrpClient({
      baseUrl: "https://crp.example/api",
      username: "tester",
      password: "secret",
      tokenPath,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return String(input).endsWith("/login")
          ? json({ Token: "fresh.jwt.token" })
          : json({ Name: "crp-user" });
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const token = await withLogin.login();

    assert.equal(token, "fresh.jwt.token");
    const loginCall = calls.find((call) => call.url.endsWith("/login"));
    assert.ok(loginCall);
    assert.equal((loginCall.body as { userName: string }).userName, "tester");
    assert.match(String((loginCall.body as { password: string }).password), /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(readFileSync(tokenPath, "utf8"), "fresh.jwt.token");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);

    await withLogin.getCurrentUser();
    const userCall = calls.find((call) => call.url.endsWith("/user"));
    assert.equal(userCall?.headers.Authorization, "Bearer fresh.jwt.token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("磁盘上有可用 token 时不再登录", async () => {
  const dir = mkdtempSync(join(homedir(), ".cache", "crp-tests", "cache-"));
  const tokenPath = join(dir, "jwt");
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  const cached = `header.${Buffer.from(JSON.stringify({ exp: farFuture })).toString("base64url")}.sig`;
  try {
    writeFileSync(tokenPath, cached);

    const { calls, fetchImpl } = makeFetch([["GET /user", json({ Name: "cached-user" })]]);
    const client = createCrpClient({
      baseUrl: "https://crp.example/api",
      username: "tester",
      password: "secret",
      tokenPath,
      fetchImpl,
      sleepImpl: async () => {},
    });

    const user = await client.getCurrentUser();

    assert.equal(user.name, "cached-user");
    assert.equal(calls.some((call) => call.url.endsWith("/login")), false);
    assert.equal(calls[0]?.headers.Authorization, `Bearer ${cached}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token 被拒绝且没有凭据时抛认证错误，消息给状态码但不含 token", async () => {
  const { client } = mockClient([
    ["GET /user", json({ message: "Token is invalid" }, 401)],
  ]);

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpAuthError);
      assert.equal(error.status, 401);
      assert.match(error.message, /GET \/user/);
      assert.match(error.message, /401/);
      assert.equal(error.message.includes(TEST_TOKEN), false);
      assert.equal(JSON.stringify(error.responseSnippet).includes(TEST_TOKEN), false);
      return true;
    },
  );
});

test("token 被拒绝但有凭据时换一次新 token 再重放原请求", async () => {
  let userCalls = 0;
  const { fetchImpl, calls } = makeFetch([
    ["POST /login", json({ Token: "second.jwt" })],
    [
      "GET /user",
      () => {
        userCalls += 1;
        return userCalls === 1 ? json({ message: "expired" }, 401) : json({ Name: "renewed" });
      },
    ],
  ]);

  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: "stale.jwt",
    username: "tester",
    password: "secret",
    tokenPath: null,
    fetchImpl,
    sleepImpl: async () => {},
  });

  const user = await client.getCurrentUser();

  assert.equal(user.name, "renewed");
  assert.equal(calls.filter((call) => call.url.endsWith("/login")).length, 1);
  assert.equal(calls.at(-1)?.headers.Authorization, "Bearer second.jwt");
});

test("5xx 且没有 message 时重试三次后抛网络错误，退避按 300/600/1200 毫秒", async () => {
  const { client, sleeps, calls } = mockClient([
    ["GET /user", json({}, 503)],
  ]);

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpNetworkError);
      assert.equal(error.status, 503);
      return true;
    },
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [300, 600, 1200]);
});

test("5xx 带 message 时视为业务拒绝，不重试", async () => {
  const { client, sleeps, calls } = mockClient([
    ["GET /user", json({ message: "版本中不能包含'-'字符" }, 500)],
  ]);

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpBusinessError);
      assert.match(error.message, /版本中不能包含/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("429 归为限流而不是网络错误：文案说明限流、带上 Retry-After，且一次都不重试", async () => {
  const { client, sleeps, calls } = mockClient([
    ["GET /user", new Response("", { status: 429, headers: { "Retry-After": "120" } })],
  ]);

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpRateLimitedError);
      assert.equal(error.kind, "rate_limited");
      assert.equal(error.status, 429);
      assert.match(error.message, /限流/);
      assert.match(error.message, /Retry-After: 120/);
      // 不能再描述成「服务端异常」：那会让人去排查代码，实际只要等。
      assert.equal(error.message.includes("服务端异常"), false);
      return true;
    },
  );

  assert.equal(calls.length, 1, "429 不重试：限流窗口里再发一次只是加大压力");
  assert.deepEqual(sleeps, []);
});

test("429 带 message 也还是限流，不被当成业务拒绝", async () => {
  const { client, calls } = mockClient([
    ["GET /user", json({ message: "too many requests" }, 429)],
  ]);

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpRateLimitedError);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("连不上网络时重试后抛网络错误，消息说明是超时还是连接失败", async () => {
  const timeouts: string[] = [];
  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    retries: 1,
    sleepImpl: async () => {},
    fetchImpl: (async () => {
      const error = new Error("connect ECONNREFUSED");
      timeouts.push(error.message);
      throw error;
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => client.getCurrentUser(),
    (error: unknown) => {
      assert.ok(error instanceof CrpNetworkError);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );

  assert.equal(timeouts.length, 2);
});

test("建 Topic 的裸数字响应被解析成 topicId，Owner 默认取当前账号", async () => {
  const { client, calls } = mockClient([
    ["GET /user", json({ Name: "crp-user", NameCN: "CRP 用户" })],
    ["POST /branches/108/topics", new Response("29157", { status: 201 })],
  ]);

  const topic = await client.createTopic({ name: "a2-verify", branchId: 108 });

  assert.equal(topic.topicId, 29157);
  assert.equal(topic.owner, "crp-user");

  const createCall = calls.find((call) => call.url.endsWith("/topics"));
  const body = createCall?.body as { Owner: string; BranchID: number; Type: string };
  assert.equal(body.Owner, "crp-user");
  assert.equal(body.BranchID, 108);
  assert.equal(body.Type, "test");
});

test("投递时不带 Tag 且 ChangeLogMode 默认 false，本地就拦下，请求不发出去", async () => {
  const { client, calls } = mockClient([["GET /user", json({ Name: "x" })]]);

  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "dde-file-manager",
        branch: "develop/eagle",
        commit: "abc123",
        branchId: 108,
        arches: "amd64;arm64",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpInvalidParameterError);
      assert.match(error.message, /版本号/);
      return true;
    },
  );

  assert.equal(calls.length, 0);
});

test("Tag 含实测会被拒的字符时本地拦下", async () => {
  const { client, calls } = mockClient([["GET /user", json({ Name: "x" })]]);

  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "pkg",
        branch: "develop/eagle",
        commit: "abc123",
        branchId: 108,
        arches: "amd64;arm64",
        tag: "9.9.9-rc1",
      }),
    CrpInvalidParameterError,
  );

  assert.equal(calls.length, 0);
});

test("投递时缺 ProjectID 会先按软件包名查，请求体里 BranchID 是字符串、Tag 原样", async () => {
  const { client, calls } = mockClient([
    ["POST /project", json({ Projects: [{ ID: 8, Name: "dde-file-manager" }] })],
    ["POST /topics/29157/new_release", new Response("107438", { status: 201 })],
  ]);

  const release = await client.submitRelease({
    topicId: 29157,
    projectName: "dde-file-manager",
    branch: "develop/eagle",
    commit: "f8e9527a",
    branchId: 108,
    tag: "9.9.9",
    arches: "amd64;arm64",
  });

  assert.equal(release.releaseId, 107438);
  assert.equal(release.projectId, 8);

  const submitCall = calls.find((call) => call.url.endsWith("/new_release"));
  const body = submitCall?.body as Record<string, unknown>;
  assert.equal(body.ProjectID, 8);
  assert.equal(body.BranchID, "108");
  assert.equal(body.ChangeLogMode, false);
  assert.equal(body.Tag, "9.9.9");
  assert.equal(body.TopicType, "test");
  assert.deepEqual(body.Changelog, [""]);
});

test("查不到软件包时抛业务错误，并说明查的是哪个分支", async () => {
  const { client } = mockClient([["POST /project", json({ Projects: null })]]);

  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "no-such-pkg",
        branch: "develop/eagle",
        commit: "abc",
        branchId: 108,
        tag: "9.9.9",
        arches: "amd64;arm64",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpBusinessError);
      assert.match(error.message, /no-such-pkg/);
      assert.match(error.message, /108/);
      return true;
    },
  );
});

test("ChangeLogMode=true 时不校验 Tag，请求体里 ChangeLogMode 为 true", async () => {
  const { client, calls } = mockClient([
    ["POST /topics/1/new_release", new Response("107439", { status: 201 })],
  ]);

  const release = await client.submitRelease({
    topicId: 1,
    projectName: "pkg",
    branch: "develop/eagle",
    commit: "abc",
    branchId: 108,
    projectId: 8,
    arches: "amd64;arm64",
    changeLogMode: true,
  });

  assert.equal(release.releaseId, 107439);
  const body = calls[0]?.body as Record<string, unknown>;
  assert.equal(body.ChangeLogMode, true);
});

test("CRP 用「commitID 长度异常」拒绝短提交号时，翻成可读的参数错误", async () => {
  const { client } = mockClient([
    [
      "POST /topics/1/new_release",
      json({ message: "commitID 长度异常 请重新提交" }, 500),
    ],
  ]);

  // 实测：短提交号能建 Topic，投递时才被 CRP 拒（MKACG-927）。这是提交号本身的问题，
  // 不能让调用方把它当成「CRP 服务端异常」去重试，要直接说清需要 40 位。
  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "pkg",
        branch: "develop/eagle",
        commit: "587bde6b1d3f",
        branchId: 108,
        projectId: 8,
        arches: "amd64;arm64",
        tag: "9.9.9",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpInvalidParameterError, "应当是可读的参数错误");
      assert.match(error.message, /完整的 40 位/);
      // 原话还在摘要里，排查时能对上是 CRP 的哪句拒绝。
      assert.match(error.responseSnippet ?? "", /commitID 长度异常/);
      return true;
    },
  );
});

test("CRP 的其它业务拒绝不被当成提交号问题", async () => {
  const { client } = mockClient([
    ["POST /topics/1/new_release", json({ message: "project not found" }, 500)],
  ]);

  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "pkg",
        branch: "develop/eagle",
        commit: "587bde6b1d3f61c4d634603fe8c8f7210d255a9a",
        branchId: 108,
        projectId: 8,
        arches: "amd64;arm64",
        tag: "9.9.9",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpBusinessError, "不是提交号长度问题，保持原分类");
      return true;
    },
  );
});

test("Release 列表解析出 Release ID、构建 ID、Tag 与构建状态", async () => {
  const { client } = mockClient([
    [
      "GET /topics/29157/releases",
      json([
        {
          ID: 107438,
          TopicID: 29157,
          ProjectID: 8,
          ProjectName: "dde-file-manager",
          Branch: "develop/eagle",
          Commit: "f8e9527a",
          Tag: "9.9.9",
          BuildID: 600197,
          BuildState: { state: "APPLYING", log: "" },
          Changelog: [""],
          ChangeLogMode: false,
        },
      ]),
    ],
  ]);

  const releases = await client.listReleases(29157);

  assert.deepEqual(
    releases.map((item) => ({
      releaseId: item.releaseId,
      buildId: item.buildId,
      tag: item.tag,
      buildState: item.buildState,
      changeLogMode: item.changeLogMode,
    })),
    [
      {
        releaseId: 107438,
        buildId: 600197,
        tag: "9.9.9",
        buildState: "APPLYING",
        changeLogMode: false,
      },
    ],
  );
});

test("删除与重试 Release 走对的路径和方法", async () => {
  const { client, calls } = mockClient([
    ["DELETE /topic_releases/107438", json({ code: "http.StatusOK", status: "success" })],
    ["POST /topic_releases/107438/retry", json({ code: "http.StatusOK", status: "success" })],
  ]);

  await client.deleteRelease(107438);
  await client.retryRelease(107438);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "DELETE /api/topic_releases/107438",
      "POST /api/topic_releases/107438/retry",
    ],
  );
});

test("仓库地址为空时返回空数组，不返回 [null]", async () => {
  const { client } = mockClient([
    ["POST /topic_urls", json({ OSTree: null, RepoUrls: null, GitInfo: null })],
  ]);

  const urls = await client.topicUrls({ branchId: 108, topicId: 29157 });

  assert.deepEqual(urls.repoUrls, []);
});

test("仓库地址是字符串或数组时都能整理成字符串数组", async () => {
  const single = mockClient([
    ["POST /topic_urls", json({ RepoUrls: "https://aptly.example/eagle-1071/topic" })],
  ]);
  assert.deepEqual((await single.client.topicUrls({ branchId: 108, topicId: 1 })).repoUrls, [
    "https://aptly.example/eagle-1071/topic",
  ]);

  const many = mockClient([
    ["POST /topic_urls", json({ RepoUrls: ["https://a", "https://b"] })],
  ]);
  assert.deepEqual((await many.client.topicUrls({ branchId: 108, topicId: 1 })).repoUrls, [
    "https://a",
    "https://b",
  ]);
});

test("工作流进度按数值返回，可直接与 20 比较", async () => {
  const { client } = mockClient([
    [
      "GET /topics/29157/workflow/info",
      json({ ID: 0, TopicID: 0, WorkProgress: 0 }),
    ],
  ]);

  const workflow = await client.getTopicWorkflow(29157);

  assert.equal(workflow.topicId, 29157);
  assert.equal(workflow.workProgress, 0);
  assert.ok(workflow.workProgress < 20);
});

test("参数不合法时根本不发请求", async () => {
  const { client, calls } = mockClient([]);

  await assert.rejects(() => client.createTopic({ name: "  ", branchId: 108 }), CrpInvalidParameterError);
  await assert.rejects(() => client.createTopic({ name: "x", branchId: 0 }), CrpInvalidParameterError);
  await assert.rejects(() => client.deleteRelease(0), CrpInvalidParameterError);
  await assert.rejects(() => client.getTopicWorkflow(-1), CrpInvalidParameterError);
  await assert.rejects(() => client.searchProjects({ name: " ", branchId: 108 }), CrpInvalidParameterError);

  assert.equal(calls.length, 0);
});

test("没有凭据也没有 token 时，需要认证的请求抛参数错误而不是发出裸请求", async () => {
  const { fetchImpl, calls } = makeFetch([]);
  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    tokenPath: null,
    fetchImpl,
    sleepImpl: async () => {},
  });

  await assert.rejects(() => client.getCurrentUser(), CrpInvalidParameterError);
  assert.equal(calls.length, 0);
});

test("创建 token 缓存目录时保持家目录以外不写文件", async () => {
  const dir = mkdtempSync(join(homedir(), ".cache", "crp-tests", "mode-"));
  try {
    mkdirSync(join(dir, "nested"));
    const { fetchImpl } = makeFetch([["POST /login", json({ Token: "t" })]]);
    const client = createCrpClient({
      baseUrl: "https://crp.example/api",
      username: "u",
      password: "p",
      tokenPath: join(dir, "nested", "jwt"),
      fetchImpl,
      sleepImpl: async () => {},
    });

    await client.login();

    assert.equal(statSync(join(dir, "nested", "jwt")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("放弃 Topic 时把 Owner 折成字符串、Abandoned 置真，字段原样带回", async () => {
  const { client, calls } = mockClient([
    [
      "GET /topics/29157",
      json({
        ID: 29157,
        Name: "a2-verify",
        NameB64: "YTItdmVyaWZ5",
        Description: "a2-verify",
        BranchID: 108,
        Completed: false,
        Type: "test",
        Abandoned: false,
        Owner: [{ employeeid: "1", mail: "crp-user@example.com", name: "crp-user" }],
        Members: null,
      }),
    ],
    ["PUT /topics/29157", json({ ID: 29157, Abandoned: true })],
  ]);

  await client.abandonTopic(29157);

  const putCall = calls.find((call) => call.method === "PUT");
  const body = putCall?.body as Record<string, unknown>;
  assert.equal(body.Owner, "crp-user");
  assert.equal(body.Members, null);
  assert.equal(body.Abandoned, true);
  assert.equal(body.NameB64, "YTItdmVyaWZ5");
});

test("放弃 Topic 前先读回来，读不到就不发 PUT", async () => {
  const { client, calls } = mockClient([
    ["GET /topics/1", json({ message: "topic not found" }, 404)],
  ]);

  await assert.rejects(() => client.abandonTopic(1), CrpBusinessError);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
});

test("只模糊匹配到同名前缀的别的包时拒绝投递，并列出候选", async () => {
  const { client, calls } = mockClient([
    [
      "POST /project",
      json({
        Projects: [
          { ID: 91, Name: "dde-kwin" },
          { ID: 103, Name: "kwindowsystem" },
        ],
      }),
    ],
  ]);

  await assert.rejects(
    () =>
      client.submitRelease({
        topicId: 1,
        projectName: "kwin",
        branch: "develop/eagle",
        commit: "abc",
        branchId: 108,
        tag: "9.9.9",
        arches: "amd64;arm64",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CrpBusinessError);
      assert.match(error.message, /kwin/);
      assert.match(error.message, /dde-kwin/);
      assert.match(error.message, /kwindowsystem/);
      return true;
    },
  );

  assert.equal(calls.filter((call) => call.url.endsWith("/new_release")).length, 0);
});

// ---------------------------------------------------------------------------
// 调用观察者：A12 的「每次对 CRP 的调用都有记录」靠它
// ---------------------------------------------------------------------------

test("每次请求都会回调观察者一次，带地址、状态码与耗时", async () => {
  const { fetchImpl } = makeFetch([
    ["GET /branches", new Response(JSON.stringify([{ ID: 108, Name: "eagle-1071" }]))],
  ]);

  const observations: Array<{ url: string; statusCode: number | null; durationMs: number }> = [];

  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    fetchImpl,
    onRequest: (record) => {
      observations.push({
        url: record.url,
        statusCode: record.statusCode,
        durationMs: record.durationMs,
      });
    },
  });

  await client.listBranches();

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.url, "https://crp.example/api/branches");
  assert.equal(observations[0]?.statusCode, 200);
  assert.ok((observations[0]?.durationMs ?? -1) >= 0);
});

test("被 CRP 拒绝的请求照样留下记录，状态码与响应摘要都在", async () => {
  const { fetchImpl } = makeFetch([
    ["POST /topics/1/new_release", new Response(JSON.stringify({ message: "project not found" }), { status: 500 })],
  ]);

  const observations: Array<{
    statusCode: number | null;
    responseSnippet: string | null;
  }> = [];

  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    fetchImpl,
    retries: 0,
    onRequest: (record) => {
      observations.push({ statusCode: record.statusCode, responseSnippet: record.responseSnippet });
    },
  });

  await assert.rejects(() =>
    client.submitRelease({
      topicId: 1,
      projectName: "kwin",
      branch: "develop/eagle",
      commit: "abc",
      branchId: 108,
      projectId: 8,
      arches: "amd64;arm64",
      tag: "9.9.9",
    }),
  );

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.statusCode, 500);
  assert.match(observations[0]?.responseSnippet ?? "", /project not found/);
});

test("连不上时也留一条记录，状态码为空、摘要是失败原因", async () => {
  const networkFetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;

  const observations: Array<{
    statusCode: number | null;
    responseSnippet: string | null;
  }> = [];

  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    fetchImpl: networkFetch,
    retries: 0,
    onRequest: (record) => {
      observations.push({ statusCode: record.statusCode, responseSnippet: record.responseSnippet });
    },
  });

  await assert.rejects(() => client.listBranches(), (error: unknown) => error instanceof CrpNetworkError);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.statusCode, null);
  assert.match(observations[0]?.responseSnippet ?? "", /ECONNREFUSED/);
});

test("观察者自己抛错不影响这次请求", async () => {
  const { fetchImpl } = makeFetch([
    ["GET /branches", new Response(JSON.stringify([{ ID: 108, Name: "eagle-1071" }]))],
  ]);

  const client = createCrpClient({
    baseUrl: "https://crp.example/api",
    token: TEST_TOKEN,
    tokenPath: null,
    fetchImpl,
    onRequest: () => {
      throw new Error("记录写不进去");
    },
  });

  const branches = await client.listBranches();

  assert.equal(branches.length, 1);
});
