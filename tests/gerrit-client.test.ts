import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";

import { CredentialMissingError } from "../lib/credentials";
import {
  createGerritClient,
  encodeGitilesRef,
  GerritAuthError,
  GerritError,
  GerritNotFoundError,
  MAX_COMMITS,
  normalizeRef,
  readGerritConfig,
  stripGerritPrefix,
  type GerritConfig,
} from "../lib/integrations/gerrit/client";

const config: GerritConfig = {
  baseUrl: "https://gerrit.example.com",
  username: "demo-user",
  httpPassword: "demo-secret-value",
  timeoutMs: 1_000,
};

const changelogText = `demo (1.2.3-1) unstable; urgency=medium

  * 修复一个缺陷

 -- Zhang San <zhangsan@uniontech.com>  Mon, 06 Nov 2023 10:00:00 +0800
`;

type Captured = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: (captured: Captured) => Response) {
  const calls: Captured[] = [];

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const captured = { url: String(input), init };
    calls.push(captured);
    return respond(captured);
  };

  return { fetchImpl, calls };
}

test("stripGerritPrefix 去掉 XSSI 前缀，没有前缀时原样返回", () => {
  assert.equal(stripGerritPrefix(')]}\'\n[{"ref":"HEAD"}]'), '\n[{"ref":"HEAD"}]');
  assert.equal(stripGerritPrefix('[{"ref":"HEAD"}]'), '[{"ref":"HEAD"}]');
});

test("分支名带斜杠时保持分段，不整串转义也不截断", () => {
  assert.equal(normalizeRef("develop/eagle"), "refs/heads/develop/eagle");
  assert.equal(normalizeRef("refs/tags/v1"), "refs/tags/v1");
  assert.equal(encodeGitilesRef("develop/eagle"), "refs/heads/develop/eagle");
});

test("提交号不补 refs/heads/ 前缀，分支与标签行为不变", () => {
  const fullSha = "9286cd554592bdcee8909f697af6a581086643b3";

  // 完整提交号与短提交号都原样传给 gitiles
  assert.equal(normalizeRef(fullSha), fullSha);
  assert.equal(normalizeRef("9286cd5"), "9286cd5");
  assert.equal(encodeGitilesRef(fullSha), fullSha);
  assert.equal(encodeGitilesRef("9286cd5"), "9286cd5");

  // 分支与标签保持原有行为
  assert.equal(normalizeRef("develop/eagle"), "refs/heads/develop/eagle");
  assert.equal(normalizeRef("refs/tags/v1"), "refs/tags/v1");
  assert.equal(encodeGitilesRef("refs/tags/v1"), "refs/tags/v1");
});

test("listBranches 解析带 XSSI 前缀的响应，并给出短分支名", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () =>
      new Response(
        `)]}'\n[{"ref":"HEAD","revision":"develop/eagle"},{"ref":"refs/heads/develop/eagle","revision":"abc123"}]`,
        { status: 200 },
      ),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });
  const branches = await client.listBranches("deepin-kde/kwin");

  assert.deepEqual(branches, [
    { ref: "HEAD", branch: "HEAD", revision: "develop/eagle" },
    { ref: "refs/heads/develop/eagle", branch: "develop/eagle", revision: "abc123" },
  ]);
  assert.equal(
    calls[0]?.url,
    "https://gerrit.example.com/a/projects/deepin-kde%2Fkwin/branches/",
  );
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("demo-user:demo-secret-value").toString("base64")}`,
  );
  assert.equal(calls[0]?.init?.redirect, "manual");
});

test("gitiles 请求挂在 /a/ 前缀下，认证由 Basic 头带上", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () => new Response(`)]}'\n{"log":[]}`, { status: 200 }),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });
  await client.listCommits("deepin-kde/kwin", "develop/eagle", 5);

  assert.equal(
    calls[0]?.url,
    "https://gerrit.example.com/a/plugins/gitiles/deepin-kde/kwin/+log/refs/heads/develop/eagle?format=JSON&n=5",
  );
});

test("提交条数超过上限时只保留上限条", async () => {
  const log = Array.from({ length: 100 }, (_, index) => ({
    commit: `sha-${index}`,
    parents: [],
    author: { name: "a", email: "a@example.com", time: "t" },
    committer: { name: "c", email: "c@example.com", time: "t" },
    message: `commit ${index}`,
  }));

  const { fetchImpl } = fakeFetch(
    () => new Response(`)]}'\n${JSON.stringify({ log })}`, { status: 200 }),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });

  assert.equal((await client.listCommits("p/q", "develop/eagle", 1000)).length, MAX_COMMITS);
  assert.equal((await client.listCommits("p/q", "develop/eagle", 3)).length, 3);
  assert.equal((await client.listCommits("p/q", "develop/eagle")).length, MAX_COMMITS);
});

test("getCommit 把 gitiles 字段映射成提交结构", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () =>
      new Response(
        `)]}'\n{"commit":"fd6b2f3","parents":[{"commit":"bfd4f5c"}],"author":{"name":"王达","email":"wangda@uniontech.com","time":"Mon, 06 Nov 2023 10:00:00 +0800"},"committer":{"name":"王达","email":"wangda@uniontech.com","time":"Mon, 06 Nov 2023 10:00:00 +0800"},"message":"fix: 修复\\n"}`,
        { status: 200 },
      ),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });
  const commit = await client.getCommit("deepin-kde/kwin", "fd6b2f3");

  assert.equal(
    calls[0]?.url,
    "https://gerrit.example.com/a/plugins/gitiles/deepin-kde/kwin/+/fd6b2f3?format=JSON",
  );
  assert.deepEqual(commit, {
    sha: "fd6b2f3",
    parents: ["bfd4f5c"],
    author: { name: "王达", email: "wangda@uniontech.com", time: "Mon, 06 Nov 2023 10:00:00 +0800" },
    committer: { name: "王达", email: "wangda@uniontech.com", time: "Mon, 06 Nov 2023 10:00:00 +0800" },
    message: "fix: 修复\n",
  });
});

test("readChangelog 解 base64 并解析首条版本号", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () => new Response(Buffer.from(changelogText, "utf8").toString("base64"), { status: 200 }),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });
  const { entry, text } = await client.readChangelog("deepin-kde/kwin", "develop/snipe");

  assert.equal(
    calls[0]?.url,
    "https://gerrit.example.com/a/plugins/gitiles/deepin-kde/kwin/+/refs/heads/develop/snipe/debian/changelog?format=TEXT",
  );
  assert.equal(entry.version, "1.2.3-1");
  assert.equal(entry.packageName, "demo");
  assert.equal(text, changelogText);
});

test("readChangelog 传提交号时请求路径用提交号，不补 refs/heads/ 前缀", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () => new Response(Buffer.from(changelogText, "utf8").toString("base64"), { status: 200 }),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });
  const shortSha = await client.readChangelog("deepin-kde/kwin", "9286cd5");
  const fullSha = await client.readChangelog(
    "deepin-kde/kwin",
    "9286cd554592bdcee8909f697af6a581086643b3",
  );

  assert.equal(
    calls[0]?.url,
    "https://gerrit.example.com/a/plugins/gitiles/deepin-kde/kwin/+/9286cd5/debian/changelog?format=TEXT",
  );
  assert.equal(
    calls[1]?.url,
    "https://gerrit.example.com/a/plugins/gitiles/deepin-kde/kwin/+/9286cd554592bdcee8909f697af6a581086643b3/debian/changelog?format=TEXT",
  );
  assert.equal(shortSha.entry.version, "1.2.3-1");
  assert.equal(fullSha.entry.version, "1.2.3-1");
});

test("changelog 不存在时抛出可读的「找不到」错误，不返回空版本号", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 404 }));
  const client = createGerritClient(config, { fetch: fetchImpl });

  await assert.rejects(
    () => client.readChangelog("deepin-kde/no-such-repo", "develop/eagle"),
    (error: unknown) => {
      assert.ok(error instanceof GerritNotFoundError);
      assert.match(error.message, /deepin-kde\/no-such-repo/);
      assert.match(error.message, /debian\/changelog/);
      return true;
    },
  );
});

test("项目不存在时抛出可读的「找不到」错误", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("Not found: x", { status: 404 }));
  const client = createGerritClient(config, { fetch: fetchImpl });

  await assert.rejects(
    () => client.listBranches("deepin-kde/no-such-repo"),
    (error: unknown) => {
      assert.ok(error instanceof GerritNotFoundError);
      assert.match(error.message, /deepin-kde\/no-such-repo/);
      return true;
    },
  );
});

test("凭据被拒（302 跳登录页）时判定为认证错误，且错误信息不含密码", async () => {
  const { fetchImpl } = fakeFetch(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://gerrit.example.com/login/" },
      }),
  );

  const client = createGerritClient(config, { fetch: fetchImpl });

  await assert.rejects(
    () => client.listBranches("deepin-kde/kwin"),
    (error: unknown) => {
      assert.ok(error instanceof GerritAuthError);
      assert.ok(!error.message.includes(config.httpPassword));
      assert.match(error.message, /我的账号/);
      return true;
    },
  );
});

test("401 判定为认证错误，且错误信息不含密码", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 401 }));
  const client = createGerritClient(config, { fetch: fetchImpl });

  await assert.rejects(
    () => client.listBranches("deepin-kde/kwin"),
    (error: unknown) => {
      assert.ok(error instanceof GerritAuthError);
      assert.ok(!error.message.includes(config.httpPassword));
      return true;
    },
  );
});

test("响应不是 JSON 时抛出 GerritError，不把原文当数据返回", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("<html>login</html>", { status: 200 }));
  const client = createGerritClient(config, { fetch: fetchImpl });

  await assert.rejects(() => client.listBranches("deepin-kde/kwin"), GerritError);
});

test("按人读配置：这个人没配 Gerrit 凭据时抛 CredentialMissingError，消息指向配置页", async () => {
  await assert.rejects(
    () => readGerritConfig("00000000-0000-4000-8000-000000000986"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialMissingError);
      assert.equal(error.kind, "gerrit");
      assert.match(error.message, /我的账号/);
      assert.match(error.message, /\/settings\/credentials/);
      return true;
    },
  );
});
