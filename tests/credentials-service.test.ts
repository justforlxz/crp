/**
 * 凭据的存取与「保存前验证」（MKACG-986）。
 *
 * 连真数据库，只有外部系统的 HTTP 层换成了假的。锁住契约第四、五、八、九节的几条：
 *
 * - **CRED-1 明文不入库**：配置一份凭据后直接查表，任何一列都找不到明文；
 * - **CRED-2 不对外回传密码**：`CredentialView` 只有四样，密文与明文都不出现；
 * - **CRED-3 保存前验证**：密码错了就抛错，表里没有新增记录；
 * - **CRED-6 未配置的拦截**：没配凭据时抛 `CredentialMissingError`，消息指向配置页；
 * - **CRED-8 密文不可跨人挪用**：把 A 的密文抄到 B 的行上，解密失败。
 *
 * 还有一条容易漏的分支：**已有凭据的人这次填错了密码**，旧凭据不能被清掉，只记 `lastError`。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import {
  CredentialDecryptError,
  CredentialMissingError,
  CredentialVerifyError,
  deleteCredential,
  listCredentialViews,
  loadCredentialSecret,
  requireCredentialSecret,
  saveCredential,
} from "../lib/credentials";
import {
  clearAllCachedTokens,
  readCachedToken,
  writeCachedToken,
} from "../lib/integrations/crp/tokenCache";
import { prisma } from "../lib/db";

const PREFIX = "zzcred";
const KEY = Buffer.alloc(32, 5).toString("base64");
const ENV = { CREDENTIAL_ENCRYPTION_KEY: KEY };
const CRP_BASE = "https://crp.example.test/api";

type Fixture = { userA: string; userB: string; userC: string };

let fixture: Fixture;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 假 CRP：`/login` 认 `good-password`，其余返回账号信息。 */
function fakeCrpFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);

    if (!url.endsWith("/login")) {
      return json({ Name: "whoever" });
    }

    return json({ Token: "test.jwt.token" });
  }) as unknown as typeof fetch;
}

/** 假 CRP：登录一律 401，并带 CRP 自己的那句话。 */
function rejectingCrpFetch(): typeof fetch {
  return (async () => json({ message: "用户名或密码错误" }, 401)) as unknown as typeof fetch;
}

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((item) => item.id);

  if (ids.length > 0) {
    await prisma.userCredential.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function createUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${suffix}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} ${suffix}`,
    },
    select: { id: true },
  });

  return user.id;
}

before(async () => {
  await cleanup();

  fixture = {
    userA: await createUser("a"),
    userB: await createUser("b"),
    userC: await createUser("c"),
  };
});

after(async () => {
  await cleanup();
});

test("保存成功后表里只有密文：任何一列都搜不到明文（CRED-1）", async () => {
  const secret = "plain-password-a";

  await saveCredential(
    { userId: fixture.userA, kind: "crp", username: "alice", secret },
    { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
  );

  const row = await prisma.userCredential.findUnique({
    where: { userId_kind: { userId: fixture.userA, kind: "crp" } },
  });

  assert.ok(row);
  for (const [column, value] of Object.entries(row)) {
    assert.ok(
      !String(value).includes(secret),
      `列 ${column} 里出现了明文密码：${String(value)}`,
    );
  }
  assert.equal(row.username, "alice");
  assert.ok(row.verifiedAt instanceof Date);
  assert.equal(row.lastError, null);
});

test("对外的凭据形态只有「配没配、账号名、最后验证时间、最后错误」（CRED-2）", async () => {
  const views = await listCredentialViews(fixture.userA);

  assert.deepEqual(
    views.map((view) => view.kind),
    ["crp", "gerrit"],
  );

  const crp = views[0];
  assert.ok(crp);
  assert.deepEqual(Object.keys(crp).sort(), [
    "configured",
    "kind",
    "label",
    "lastError",
    "username",
    "verifiedAt",
  ]);

  const serialized = JSON.stringify(views);
  assert.ok(!serialized.includes("plain-password-a"));
  assert.ok(!serialized.includes("secretCiphertext"));
  assert.ok(!serialized.includes("secretIv"));
  assert.ok(!serialized.includes("secretTag"));
});

test("没配 Gerrit 凭据时是「未配置」，不是「配置错了」", async () => {
  const views = await listCredentialViews(fixture.userA);
  const gerrit = views.find((view) => view.kind === "gerrit");

  assert.ok(gerrit);
  assert.equal(gerrit.configured, false);
  assert.equal(gerrit.username, null);
  assert.equal(gerrit.verifiedAt, null);
});

test("保存前必须真登录一次：密码错了不入库，原因原样带回（CRED-3）", async () => {
  await assert.rejects(
    () =>
      saveCredential(
        { userId: fixture.userB, kind: "crp", username: "bob", secret: "wrong" },
        { fetchImpl: rejectingCrpFetch(), baseUrl: CRP_BASE, env: ENV },
      ),
    (error: unknown) => {
      assert.ok(error instanceof CredentialVerifyError);
      assert.equal(error.kind, "crp");
      assert.match(error.reason, /用户名或密码错误/);
      return true;
    },
  );

  const count = await prisma.userCredential.count({ where: { userId: fixture.userB } });
  assert.equal(count, 0, "验证没通过却写进了库");
});

test("已有凭据的人这次填错密码：旧凭据保留，只记最后错误", async () => {
  await saveCredential(
    { userId: fixture.userC, kind: "crp", username: "carol", secret: "old-secret" },
    { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
  );

  const before = await prisma.userCredential.findUniqueOrThrow({
    where: { userId_kind: { userId: fixture.userC, kind: "crp" } },
  });

  await assert.rejects(
    () =>
      saveCredential(
        { userId: fixture.userC, kind: "crp", username: "carol2", secret: "wrong" },
        { fetchImpl: rejectingCrpFetch(), baseUrl: CRP_BASE, env: ENV },
      ),
    CredentialVerifyError,
  );

  const after = await prisma.userCredential.findUniqueOrThrow({
    where: { userId_kind: { userId: fixture.userC, kind: "crp" } },
  });

  assert.equal(after.secretCiphertext, before.secretCiphertext, "旧凭据被一次手误清掉了");
  assert.equal(after.secretIv, before.secretIv);
  assert.equal(after.username, "carol", "账号名也不该被这次失败的保存改掉");
  assert.match(after.lastError ?? "", /用户名或密码错误/);
});

test("未配置时抛 CredentialMissingError 并指向配置页（CRED-6）", async () => {
  await assert.rejects(
    () => requireCredentialSecret(fixture.userB, "gerrit", ENV),
    (error: unknown) => {
      assert.ok(error instanceof CredentialMissingError);
      assert.equal(error.kind, "gerrit");
      assert.match(error.message, /\/settings\/credentials/);
      return true;
    },
  );

  assert.equal(await loadCredentialSecret(fixture.userB, "gerrit", ENV), null);
});

test("取出来的明文可以真的拿去登录", async () => {
  const credential = await requireCredentialSecret(fixture.userA, "crp", ENV);

  assert.deepEqual(credential, { username: "alice", secret: "plain-password-a" });
});

test("CRED-8：把 A 的密文抄到 B 的行上，解密失败", async () => {
  await saveCredential(
    { userId: fixture.userB, kind: "crp", username: "bob", secret: "bob-secret" },
    { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
  );

  const stolen = await prisma.userCredential.findUniqueOrThrow({
    where: { userId_kind: { userId: fixture.userA, kind: "crp" } },
    select: { secretCiphertext: true, secretIv: true, secretTag: true, keyVersion: true },
  });

  await prisma.userCredential.update({
    where: { userId_kind: { userId: fixture.userB, kind: "crp" } },
    data: {
      secretCiphertext: stolen.secretCiphertext,
      secretIv: stolen.secretIv,
      secretTag: stolen.secretTag,
      keyVersion: stolen.keyVersion,
    },
  });

  await assert.rejects(
    () => loadCredentialSecret(fixture.userB, "crp", ENV),
    CredentialDecryptError,
  );
});

test("删掉凭据之后回到未配置，再删一次也不报错", async () => {
  await deleteCredential(fixture.userC, "crp");
  await deleteCredential(fixture.userC, "crp");

  const views = await listCredentialViews(fixture.userC);
  assert.ok(views.every((view) => !view.configured));
});

test("换账号或删凭据之后，这个人缓存的 CRP 令牌立刻失效（不会再以旧账号身份发请求）", async () => {
  clearAllCachedTokens();
  const userId = await createUser("token");
  const jwt = (name: string): string =>
    `header.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, name }),
    ).toString("base64url")}.sig`;

  try {
    await saveCredential(
      { userId, kind: "crp", username: "first", secret: "first-secret" },
      { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
    );

    // 这个人现在有一次登录留下的令牌（有效期 3 天）。
    writeCachedToken(userId, jwt("first"));
    assert.notEqual(readCachedToken(userId), null);

    // 把账号换成另一个人：旧令牌必须跟着失效，否则后续建 Topic / 投递仍以 first 的身份发出。
    await saveCredential(
      { userId, kind: "crp", username: "second", secret: "second-secret" },
      { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
    );
    assert.equal(readCachedToken(userId), null, "改账号后旧令牌还在，请求会以旧账号身份发出");

    // 别的账号的令牌不受影响。
    writeCachedToken("another-user", jwt("someone-else"));
    writeCachedToken(userId, jwt("second"));

    // 删掉凭据同样要丢令牌：账号没了还留着它的身份，等于「删了还在用」。
    await deleteCredential(userId, "crp");
    assert.equal(readCachedToken(userId), null, "删凭据后旧令牌还在");
    assert.notEqual(readCachedToken("another-user"), null);
  } finally {
    clearAllCachedTokens();
  }
});

test("验证没通过时不动已缓存的令牌：旧凭据还在用，丢掉它只是让人白白多登录一次", async () => {
  clearAllCachedTokens();
  const userId = await createUser("token-fail");
  const jwt = `header.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, name: "kept" }),
  ).toString("base64url")}.sig`;

  try {
    await saveCredential(
      { userId, kind: "crp", username: "kept", secret: "kept-secret" },
      { fetchImpl: fakeCrpFetch(), baseUrl: CRP_BASE, env: ENV },
    );
    writeCachedToken(userId, jwt);

    await assert.rejects(
      () =>
        saveCredential(
          { userId, kind: "crp", username: "kept", secret: "wrong" },
          { fetchImpl: rejectingCrpFetch(), baseUrl: CRP_BASE, env: ENV },
        ),
      CredentialVerifyError,
    );

    assert.equal(readCachedToken(userId), jwt);
  } finally {
    clearAllCachedTokens();
  }
});
