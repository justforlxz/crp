/**
 * CRP 主题读取与搜索的单测：网络层换成假的 `fetch`，走真实客户端。
 *
 * 锁住 A18 追加的两个方法：
 *
 * - `getTopic` 走 `GET /topics/{id}`，把 Owner 对象数组折成账号名；
 * - `searchTopics` 走 `GET /branches/{id}/topics?Type=test` 再按名称过滤 ——
 *   `POST /topics/search` 在这个部署上不可用（对任何请求体都返回 `null`），
 *   所以这里同时断言「一次 POST /topics/search 都没发」。
 *
 * 以及 MKACG-946 追加的「只看我的主题」（`mine`）：
 *
 * - 当前账号只能来自 `GET /user`，由客户端自己解析，调用方传不进别人的账号；
 * - Owner 三种形状都认（字符串、对象数组、`null`），对象项的 `name` 与 `namecn` 都算，
 *   比较不区分大小写；
 * - `mine` 只收窄不收宽：别人的主题一条都不许出现；
 * - 截断时 `total` 给的是截断前的命中数，页面据此提示「只显示前 N 条」；
 * - 默认按 Topic ID 倒序，最近建的在前。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createCrpClient } from "../lib/integrations/crp";

const BASE = "https://crp.example.test/api";

type Call = { method: string; path: string; search: string };

/** `GET /user` 的默认响应：LDAP 账号 `crp-user`，中文名「CRP 用户」。 */
const CURRENT_USER = { Name: "crp-user", NameCN: "CRP 用户" };

/** 一条主题的最小形状，只写测试关心的字段。 */
function topic(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    BranchID: 108,
    Type: "test",
    Abandoned: false,
    Completed: false,
    State: 0,
    Owner: null,
    ...overrides,
  };
}

/** 假 CRP：记录每次请求，按路径回固定响应。 */
function fakeCrp(
  topics: unknown[],
  user: unknown = CURRENT_USER,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";

    calls.push({
      method,
      path: parsed.pathname.replace(/^\/api/, ""),
      search: parsed.search,
    });

    if (method === "GET" && parsed.pathname.replace(/^\/api/, "") === "/user") {
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "GET" && /^\/topics\/\d+$/.test(parsed.pathname.replace(/^\/api/, ""))) {
      const id = Number(parsed.pathname.split("/").at(-1));

      return new Response(
        JSON.stringify({
          ID: id,
          Name: "【FlemingX】缩放需求实时生效联调测试",
          BranchID: 108,
          Type: "test",
          Abandoned: false,
          Completed: false,
          State: 0,
          Owner: [
            { employeeid: "1", mail: "a@example.com", name: "zhangdingyuan", namecn: "张丁元" },
            { employeeid: "2", mail: "b@example.com", name: "crp-user", namecn: "CRP 用户" },
          ],
          Members: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "GET" && /^\/branches\/\d+\/topics$/.test(parsed.pathname.replace(/^\/api/, ""))) {
      assert.equal(parsed.searchParams.get("Type"), "test", "只搜 test 类型主题");

      return new Response(JSON.stringify(topics), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 任何别的请求（尤其是 POST /topics/search）都不该发生。
    return new Response(JSON.stringify({ message: `未实现的请求 ${method} ${parsed.pathname}` }), {
      status: 404,
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

function client(fetchImpl: typeof fetch) {
  return createCrpClient({
    baseUrl: BASE,
    token: "test-token",
    tokenKey: null,
    fetchImpl,
    retries: 0,
  });
}

test("读主题：整理成调用方要的字段，Owner 折成账号名", async () => {
  const state = fakeCrp([]);
  const topic = await client(state.fetch).getTopic(29123);

  assert.equal(topic.id, 29123);
  assert.equal(topic.name, "【FlemingX】缩放需求实时生效联调测试");
  assert.equal(topic.branchId, 108);
  assert.equal(topic.type, "test");
  assert.equal(topic.abandoned, false);
  assert.equal(topic.completed, false);
  assert.equal(topic.owner, "zhangdingyuan;crp-user");
  assert.deepEqual(state.calls.map((call) => `${call.method} ${call.path}`), ["GET /topics/29123"]);
});

test("读主题：Topic ID 不合法时本地就拦下，不发请求", async () => {
  const state = fakeCrp([]);

  await assert.rejects(() => client(state.fetch).getTopic(0), /topicId 不合法/);
  assert.equal(state.calls.length, 0);
});

test("按名称搜主题：只回 test 类型、名字含关键字的那几条，一次 POST 都没发", async () => {
  const state = fakeCrp([
    // 名字匹配、类型 test：要留下
    topic({
      ID: 1,
      Name: "FlemingZ TR6增补主题",
      Owner: [{ name: "crp-user" }],
    }),
    // 名字匹配但类型不是 test：丢掉
    topic({ ID: 2, Name: "Fleming 的 dev 主题", Type: "dev" }),
    // 名字不匹配：丢掉
    topic({ ID: 3, Name: "别的主题" }),
    // 大小写不同但名字匹配：要留下（名字比较不区分大小写）
    topic({ ID: 4, Name: "yaml 打包问题" }),
  ]);

  const fleming = await client(state.fetch).searchTopics({ branchId: 108, name: "fleming" });
  assert.deepEqual(fleming.topics.map((item) => item.id), [1]);
  assert.equal(fleming.topics[0].owner, "crp-user");
  assert.equal(fleming.total, 1, "没有截断时 total 与返回条数一致");
  assert.equal(fleming.currentUser, null, "纯关键字搜索不需要解析当前账号");

  const yaml = await client(state.fetch).searchTopics({ branchId: 108, name: "YAML" });
  assert.deepEqual(yaml.topics.map((item) => item.id), [4]);

  assert.equal(
    state.calls.some((call) => call.method === "POST"),
    false,
    "不该发任何 POST，包括 POST /topics/search",
  );
  assert.equal(
    state.calls.every((call) => call.path === "/branches/108/topics"),
    true,
    "唯一的请求是列这条分支下的主题",
  );
});

test("按名称搜主题：关键字为空或分支 ID 不合法时报参数错误", async () => {
  const state = fakeCrp([]);

  await assert.rejects(
    () => client(state.fetch).searchTopics({ branchId: 108, name: "   " }),
    /name 为空/,
  );
  await assert.rejects(
    () => client(state.fetch).searchTopics({ branchId: 0, name: "kwin" }),
    /branchId 不合法/,
  );
  assert.equal(state.calls.length, 0);
});

test("按名称搜主题：结果一次性只回上限那么多条，total 仍然是截断前的命中数", async () => {
  const many = Array.from({ length: 80 }, (_, index) => topic({ ID: 1_000 + index, Name: `主题 ${index}` }));

  const result = await client(fakeCrp(many).fetch).searchTopics({ branchId: 108, name: "主题" });

  assert.equal(result.topics.length, 50, "最多 50 条，防止把整条分支的主题都塞给页面");
  assert.equal(result.total, 80, "截断前的命中条数要如实报出来，页面才能提示被截断");
});

test("按名称搜主题：按 Topic ID 倒序，最近建的排在前面", async () => {
  const state = fakeCrp([
    topic({ ID: 101, Name: "主题甲" }),
    topic({ ID: 303, Name: "主题丙" }),
    topic({ ID: 202, Name: "主题乙" }),
  ]);

  const result = await client(state.fetch).searchTopics({ branchId: 108, name: "主题" });

  assert.deepEqual(result.topics.map((item) => item.id), [303, 202, 101]);
});

test("只看我的主题：当前账号来自 GET /user，三种 Owner 形状都认，别人的一条都不出现", async () => {
  const state = fakeCrp([
    // 对象数组里 name 命中（大小写不同）：算本人
    topic({ ID: 101, Name: "我的主题 A", Owner: [{ name: "CRP-User", namecn: "CRP 用户" }] }),
    // Owner 是字符串：算本人
    topic({ ID: 102, Name: "我的主题 B", Owner: "crp-user" }),
    // 对象里只有 namecn，且大小写不同：也算本人
    topic({ ID: 103, Name: "我的主题 C", Owner: [{ namecn: "crp 用户" }] }),
    // 别人的主题：不能出现
    topic({
      ID: 104,
      Name: "别人的主题",
      Owner: [{ name: "zhangdingyuan", namecn: "张丁元" }],
    }),
    // 没有 Owner：不能出现
    topic({ ID: 105, Name: "没主人的主题", Owner: null }),
    // 本人建的不是 test 类型：不能出现
    topic({ ID: 106, Name: "我的 dev 主题", Type: "dev", Owner: "crp-user" }),
  ]);

  const result = await client(state.fetch).searchTopics({ branchId: 108, mine: true });

  assert.deepEqual(
    result.topics.map((item) => item.id),
    [103, 102, 101],
    "只留本人的 test 类型主题，并按 ID 倒序",
  );
  assert.equal(result.currentUser?.name, "crp-user", "账号名取自 GET /user");
  assert.equal(result.currentUser?.nameCn, "CRP 用户", "中文名也一并带出来，页面要显示");
  assert.equal(result.total, 3);
  assert.deepEqual(
    state.calls.map((call) => `${call.method} ${call.path}`),
    // 先问「我是谁」，再列分支下的主题：身份只能由客户端自己取，调用方传不进来。
    ["GET /user", "GET /branches/108/topics"],
  );
});

test("只看我的主题：可以同时给关键字，两个条件一起收窄", async () => {
  const state = fakeCrp([
    topic({ ID: 201, Name: "缩放联调", Owner: "crp-user" }),
    topic({ ID: 202, Name: "yaml 打包", Owner: "crp-user" }),
    topic({ ID: 203, Name: "缩放联调（别人）", Owner: [{ name: "zhangdingyuan" }] }),
  ]);

  const result = await client(state.fetch).searchTopics({
    branchId: 108,
    mine: true,
    name: "缩放",
  });

  assert.deepEqual(result.topics.map((item) => item.id), [201]);
});

test("只看我的主题：GET /user 没给账号名时报认证错误，不拿空账号去匹配", async () => {
  const state = fakeCrp([], {});

  await assert.rejects(
    () => client(state.fetch).searchTopics({ branchId: 108, mine: true }),
    /GET \/user 没有返回账号名/,
  );
  assert.deepEqual(
    state.calls.map((call) => `${call.method} ${call.path}`),
    ["GET /user"],
    "账号都拿不到就不必去列主题",
  );
});
