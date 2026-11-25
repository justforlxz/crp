/**
 * 权限组（SEC-01 ~ SEC-08）。
 *
 * 拆成三块：
 *
 * - 「未登录拦截」用真请求验（`SEC-01`、`SEC-02`），要 `BASE_URL`；
 * - 「凭据不外泄」里跟按人凭据有关的三条等 MKACG-986，先 TODO；
 * - 「环境变量里没有个人凭据」「响应里不出现作业 token」用源码与真实处理器验，不需要浏览器。
 */

import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { requestPath, walkPath } from "../support/http";
import { expectContains, expectEqual, expectOmits, expectTrue } from "../support/report";

/** 受保护页面的九个路由；`/releases/<id>` 用占位值，未登录时不该查库。 */
const PROTECTED_PAGES = [
  "/dashboard",
  "/releases",
  "/releases/00000000-0000-0000-0000-000000000000",
  "/releases/new",
  "/projects",
  "/managers",
  "/packages",
  "/baselines",
  "/webhooks",
] as const;

/** 曾经漏掉守卫的四个路径。 */
const FORMERLY_UNGUARDED = ["/packages", "/packages/new", "/baselines"] as const;

acceptanceWithEnv("SEC-01", ["baseUrl"], async () => {
  const { baseUrl } = await import("../support/env");
  const bad: string[] = [];

  for (const path of PROTECTED_PAGES) {
    // 跟完整条跳转链，而不是只看第一跳：第一跳 307 之后又跳去别处，同样算没落到登录页。
    const walked = await walkPath(baseUrl() ?? "", path);
    const first = walked.hops[0];
    const expected = `/login?next=${encodeURIComponent(path)}`;

    if (first?.status !== 307) {
      bad.push(`${path} → HTTP ${String(first?.status)}，应为 307`);
      continue;
    }

    if (first.location !== expected) {
      bad.push(`${path} → Location ${String(first.location)}，应为 ${expected}`);
      continue;
    }

    const landing = walked.hops[1];

    if (landing === undefined || landing.path !== expected) {
      bad.push(`${path} → 第二跳到了 ${String(landing?.path)}，应为 ${expected}`);
      continue;
    }

    if (landing.status !== 200) {
      bad.push(`${path} → 登录页 HTTP ${String(landing.status)}，应为 200`);
    }
  }

  expectEqual("SEC-01", "九页未登录拦截不符合预期的情况", [], bad);
});

acceptanceWithEnv("SEC-02", ["baseUrl"], async () => {
  const { baseUrl } = await import("../support/env");
  const bad: string[] = [];

  // `/packages/<id>` 也要在列，占位 ID 即可：未登录时连库都不该查。
  const paths = [...FORMERLY_UNGUARDED, "/packages/00000000-0000-0000-0000-000000000000"];

  for (const path of paths) {
    const response = await requestPath(baseUrl() ?? "", path);

    if (response.status !== 307) {
      bad.push(`${path} → HTTP ${String(response.status)}`);
    }
  }

  expectEqual("SEC-02", "曾经漏网的四个路径仍然可匿名访问的情况", [], bad);
});

acceptanceTodo(
  "SEC-03",
  "「凭据只存密文、全表搜不到明文」验的是 `UserCredential` 表与 AES-256-GCM 写入路径，两者都在 MKACG-986 里，当前 main 上没有这张表",
);

acceptanceTodo(
  "SEC-04",
  "「凭据读取接口只回是否已配置、账号名、验证时间」需要 `/settings/credentials` 的读取接口（MKACG-986）",
);

acceptanceTodo(
  "SEC-05",
  "「密文跨人挪用解不开」要有 AAD 绑定 userId + kind 的解密实现（MKACG-986）",
);

acceptanceTodo(
  "SEC-06",
  "「未配置凭据时不发任何 CRP 请求」要先有按人凭据与配置页（MKACG-986）；当前实现走环境变量，没有「用户没配」这个状态",
);

acceptanceWithEnv("SEC-07", [], async () => {
  const names = ["CRP_USERNAME", "CRP_PASSWORD", "GERRIT_HTTP_PASSWORD"];
  const offenders: string[] = [];

  /** 文档与示例文件不算：用例集要求的是「代码与配置里没有引用，只剩迁移说明」。 */
  const skipped = (path: string): boolean =>
    path.endsWith(".md") ||
    path.startsWith(".agents/") ||
    path.startsWith("docs/") ||
    path === ".env.example" ||
    // 验收用例本身要写下这三个变量名才能查它们，扫自己没有意义。
    path.startsWith("tests/acceptance/") ||
    path.startsWith("node_modules") ||
    path.startsWith("generated/") ||
    path.startsWith(".git/");

  for (const file of walk(process.cwd())) {
    const path = relative(process.cwd(), file);

    if (skipped(path)) {
      continue;
    }

    const content = readFileSync(file, "utf8");

    for (const name of names) {
      if (content.includes(name)) {
        offenders.push(`${path} 里引用了 ${name}`);
      }
    }
  }

  expectEqual("SEC-07", "代码与配置里仍引用个人凭据环境变量的位置", [], offenders);
});

acceptanceWithEnv("SEC-08", [], async () => {
  const token = "acceptance-job-token-should-not-leak";
  const previous = process.env.BUILD_POLL_JOB_TOKEN;
  process.env.BUILD_POLL_JOB_TOKEN = token;

  try {
    const { POST } = await import("../../../app/api/jobs/build-poll/route");

    // 不带 token：必须 401，且错误信息里不能把 token 回显出来。
    const unauthorized = await POST(
      new Request("http://127.0.0.1/api/jobs/build-poll", { method: "POST" }),
    );
    const body = await unauthorized.text();

    expectEqual("SEC-08", "不带作业 token 时的状态码", 401, unauthorized.status);
    expectOmits("SEC-08", "401 响应里不出现作业 token", token, body);
    expectContains("SEC-08", "401 响应说明了缺什么", "token", body.toLowerCase());

    // 带错 token：同样 401，且不回显收到的值。
    const wrong = await POST(
      new Request("http://127.0.0.1/api/jobs/build-poll", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-value" },
      }),
    );
    const wrongBody = await wrong.text();

    expectEqual("SEC-08", "带错误作业 token 时的状态码", 401, wrong.status);
    expectOmits("SEC-08", "401 响应里不出现收到的 token", "wrong-token-value", wrongBody);
    expectTrue(
      "SEC-08",
      "响应里不出现配置的作业 token",
      "响应体不含作业 token 原文",
      !body.includes(token) && !wrongBody.includes(token),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BUILD_POLL_JOB_TOKEN;
    } else {
      process.env.BUILD_POLL_JOB_TOKEN = previous;
    }
  }
});

/** 递归列出仓库里的文本文件；跳过明显的二进制与依赖目录。 */
function walk(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".next", "generated", "tests/visual"].includes(entry.name)) {
        continue;
      }

      found.push(...walk(full));
      continue;
    }

    if (!statSync(full).isFile()) {
      continue;
    }

    if (!/\.(ts|tsx|js|mjs|cjs|json|yml|yaml|toml|example|prisma)$/u.test(entry.name)) {
      continue;
    }

    if (entry.name === ".env.example") {
      continue;
    }

    found.push(full);
  }

  return found;
}
