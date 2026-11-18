/**
 * 接口与领域逻辑的集成测试：真正连数据库跑一遍。
 *
 * 数据库连接串由 `DATABASE_URL` 提供（CI 的服务容器或本机 `.env`），
 * 迁移由 `pnpm db:migrate` 先行执行；这里用的包名一律带本文件的固定前缀，
 * 跑完自己清掉，不影响种子数据。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import { POST } from "../app/api/packages/route";
import { prisma } from "../lib/db";
import {
  deletePackage,
  PackageError,
  saveDependencies,
  upsertPackages,
} from "../lib/packages";
import { parsePackagePayload } from "../lib/packages/validation";

const TOKEN = "test-token-881";
const PREFIX = "zz881";

function name(suffix: string): string {
  return `${PREFIX}-${suffix}`;
}

function repo(suffix: string): string {
  return `zz-test-881/${suffix}`;
}

function request(body: unknown, init: { token?: string | null } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = init.token === undefined ? TOKEN : init.token;

  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request("http://localhost/api/packages", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function cleanup() {
  const packages = await prisma.package.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = packages.map((item) => item.id);

  if (ids.length === 0) {
    return;
  }

  await prisma.packageDependency.deleteMany({
    where: {
      OR: [{ packageId: { in: ids } }, { upstreamPackageId: { in: ids } }],
    },
  });
  await prisma.package.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  process.env.PACKAGE_API_TOKEN = TOKEN;
  await cleanup();
});

after(cleanup);

test("没有 token 时返回 401，且不写库", async () => {
  const response = await POST(request({ name: name("a"), repoPath: repo("a"), defaultBranch: "main" }, { token: null }));

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "unauthorized");

  assert.equal(await prisma.package.count({ where: { name: name("a") } }), 0);
});

test("token 不对时返回 401", async () => {
  const response = await POST(
    request(
      { name: name("a"), repoPath: repo("a"), defaultBranch: "main" },
      { token: "wrong-token" },
    ),
  );

  assert.equal(response.status, 401);
});

test("服务端没配置 token 时也返回 401（不放开写入）", async () => {
  const previous = process.env.PACKAGE_API_TOKEN;
  delete process.env.PACKAGE_API_TOKEN;

  try {
    const response = await POST(
      request({ name: name("a"), repoPath: repo("a"), defaultBranch: "main" }),
    );
    assert.equal(response.status, 401);
  } finally {
    process.env.PACKAGE_API_TOKEN = previous;
  }
});

test("同一名称连续提交两次：库里只有一条记录，字段被更新", async () => {
  const first = await POST(
    request({
      name: name("dup"),
      repoPath: repo("dup"),
      defaultBranch: "develop/eagle",
      currentVersion: "1.0.0-1",
    }),
  );

  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { created: string[]; updated: string[] };
  assert.deepEqual(firstBody.created, [name("dup")]);
  assert.deepEqual(firstBody.updated, []);

  const second = await POST(
    request({
      name: name("dup"),
      repoPath: repo("dup"),
      defaultBranch: "develop/master",
      currentVersion: "1.0.1-1",
    }),
  );

  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { created: string[]; updated: string[] };
  assert.deepEqual(secondBody.created, []);
  assert.deepEqual(secondBody.updated, [name("dup")]);

  const rows = await prisma.package.findMany({ where: { name: name("dup") } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].defaultBranch, "develop/master");
  assert.equal(rows[0].currentVersion, "1.0.1-1");
});

test("数组提交按名称幂等，混合新建与更新", async () => {
  await prisma.package.create({
    data: {
      name: name("arr1"),
      repoPath: repo("arr1"),
      defaultBranch: "develop/eagle",
    },
  });

  const response = await POST(
    request([
      { name: name("arr1"), repoPath: repo("arr1"), defaultBranch: "develop/master" },
      { name: name("arr2"), repoPath: repo("arr2"), defaultBranch: "develop/eagle" },
    ]),
  );

  assert.equal(response.status, 201);
  const body = (await response.json()) as { created: string[]; updated: string[] };
  assert.deepEqual(body.created, [name("arr2")]);
  assert.deepEqual(body.updated, [name("arr1")]);
  assert.equal(await prisma.package.count({ where: { name: name("arr1") } }), 1);
});

test("字段校验不通过返回 400，并给出字段名", async () => {
  const response = await POST(
    request([{ name: name("ok"), repoPath: repo("ok"), defaultBranch: "main" }, { name: "" }]),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; details: { field: string }[] };
  };
  assert.equal(body.error.code, "invalid_payload");
  assert.deepEqual(
    body.error.details.map((item) => item.field),
    ["items[1].name", "items[1].repoPath", "items[1].defaultBranch"],
  );

  assert.equal(await prisma.package.count({ where: { name: name("ok") } }), 0);
});

test("请求体不是合法 JSON 时返回 400", async () => {
  const response = await POST(request("{ not json"));

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_json");
});

test("仓库路径被另一个包占用时返回 409", async () => {
  await prisma.package.create({
    data: { name: name("taken"), repoPath: repo("shared"), defaultBranch: "main" },
  });

  const response = await POST(
    request({ name: name("other"), repoPath: repo("shared"), defaultBranch: "main" }),
  );

  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "conflict");
});

test("依赖成环时拒绝保存并指出回路", async () => {
  const [a, b, c] = await Promise.all(
    ["a", "b", "c"].map((suffix) =>
      prisma.package.create({
        data: {
          name: name(suffix),
          repoPath: repo(suffix),
          defaultBranch: "develop/eagle",
        },
      }),
    ),
  );

  await saveDependencies(a.id, [b.id]);
  await saveDependencies(b.id, [c.id]);

  await assert.rejects(
    () => saveDependencies(c.id, [a.id]),
    (error: unknown) => {
      assert.ok(error instanceof PackageError);
      const message = (error as Error).message;
      assert.match(message, /依赖成环/);
      // 回路要能读出来：三个包名都在，且用箭头连成一条回路。
      assert.ok(message.includes(name("a")), message);
      assert.ok(message.includes(name("b")), message);
      assert.ok(message.includes(name("c")), message);
      assert.match(message, /→/);
      return true;
    },
  );

  // 被拒绝的那次没有写库。
  assert.equal(await prisma.packageDependency.count({ where: { packageId: c.id } }), 0);
});

test("自依赖被拒绝", async () => {
  const single = await prisma.package.create({
    data: { name: name("self"), repoPath: repo("self"), defaultBranch: "main" },
  });

  await assert.rejects(
    () => saveDependencies(single.id, [single.id]),
    /依赖成环/,
  );
});

test("依赖保存成功后可以再替换成别的上游", async () => {
  const [downstream, first, second] = await Promise.all(
    ["down", "up1", "up2"].map((suffix) =>
      prisma.package.create({
        data: {
          name: name(suffix),
          repoPath: repo(suffix),
          defaultBranch: "main",
        },
      }),
    ),
  );

  await saveDependencies(downstream.id, [first.id, second.id]);
  assert.equal(
    await prisma.packageDependency.count({ where: { packageId: downstream.id } }),
    2,
  );

  await saveDependencies(downstream.id, [second.id]);
  const rows = await prisma.packageDependency.findMany({
    where: { packageId: downstream.id },
  });
  assert.deepEqual(rows.map((item) => item.upstreamPackageId), [second.id]);
});

test("仍被项目引用的软件包不能删除", async () => {
  const project = await prisma.project.findFirst({ select: { id: true } });
  assert.ok(project, "种子数据里应当至少有一个项目");

  const pkg = await prisma.package.create({
    data: { name: name("referenced"), repoPath: repo("referenced"), defaultBranch: "main" },
  });

  await prisma.projectSoftware.create({
    data: { projectId: project.id, packageId: pkg.id, trackedBranch: "develop/eagle" },
  });

  try {
    await assert.rejects(
      () => deletePackage(pkg.id),
      (error: unknown) => {
        assert.ok(error instanceof PackageError);
        assert.equal((error as PackageError).status, 409);
        assert.match((error as Error).message, /项目引用/);
        return true;
      },
    );
  } finally {
    await prisma.projectSoftware.deleteMany({ where: { packageId: pkg.id } });
  }

  // 解除引用后就能删。
  await deletePackage(pkg.id);
  assert.equal(await prisma.package.count({ where: { id: pkg.id } }), 0);
});

test("被其他软件包依赖时不能删除", async () => {
  const [upstream, downstream] = await Promise.all(
    ["keep", "user"].map((suffix) =>
      prisma.package.create({
        data: { name: name(suffix), repoPath: repo(suffix), defaultBranch: "main" },
      }),
    ),
  );

  await saveDependencies(downstream.id, [upstream.id]);

  await assert.rejects(() => deletePackage(upstream.id), /依赖/);
});

test("upsertPackages 校验后的载荷可以直接落库", async () => {
  const parsed = parsePackagePayload({
    name: name("direct"),
    repoPath: repo("direct"),
    defaultBranch: "main",
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const result = await upsertPackages(parsed.value);
  assert.deepEqual(result.created, [name("direct")]);
});
