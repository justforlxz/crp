/**
 * 部署实例的种子数据自检（`.agents/spec/product/runtime.md` 第一节，RT-3 / RT-4）。
 *
 * 锁住两件事：
 *
 * 1. **纯种子库必须被判定为种子数据**，否则部署实例会带着演示数据对外服务；
 * 2. **真实库必须通过**，否则每次部署都起不来。
 *
 * 第 2 条不是「顺手加一个」：种子里的工作区名（`desktop-core` / 桌面核心组）与基线名
 * （`eagle-1071` 等）在真实库里**本来就会出现** —— RUNBOOK 3.6 让生产环境手工建的工作区
 * 就叫这个名字，基线同步从 CRP 拉下来的分支也叫这个名字。所以判定不能只看名字，
 * 只能看真实数据里不可能出现的值：种子写死的占位密码哈希与占位 Webhook 签名密钥。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  SEED_BASELINES,
  SEED_PASSWORD_HASH_PREFIX,
  SEED_USER_EMAILS,
  SEED_WEBHOOK_SECRET_PREFIX,
  SEED_WORKSPACES,
  detectSeedData,
  formatSeedReport,
  hasDecisiveFinding,
  type SeedGuardSnapshot,
} from "../lib/seed-guard";

/** 纯种子库：值全部取自 `prisma/seed.ts` 的常量。 */
function pureSeedSnapshot(): SeedGuardSnapshot {
  return {
    users: SEED_USER_EMAILS.map((email) => ({
      email,
      passwordHash: `${SEED_PASSWORD_HASH_PREFIX}${email.split("@")[0]}`,
    })),
    workspaces: SEED_WORKSPACES.map((item) => ({ ...item })),
    baselines: SEED_BASELINES.map((item) => ({ ...item })),
    webhookEndpoints: [
      { url: "https://hooks.example.com/crp/desktop-core", secret: `${SEED_WEBHOOK_SECRET_PREFIX}desktop-core` },
      { url: "https://hooks.example.com/crp/system-apps", secret: `${SEED_WEBHOOK_SECRET_PREFIX}system-apps` },
    ],
  };
}

/**
 * 真实库：真实账号、真实基线、真实端点。
 *
 * 工作区与基线**故意**用与种子相同的名字 —— 那是生产环境按 RUNBOOK 3.6 手工建的工作区，
 * 以及基线同步从 CRP 拉下来的 `eagle-1071`。名字相同不代表是种子数据。
 */
function realSnapshot(): SeedGuardSnapshot {
  return {
    users: [
      {
        email: "lxz@uniontech.com",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$0f3aQ9m4h1kR2xYbV7cW8g",
      },
    ],
    workspaces: [{ slug: "desktop-core", name: "桌面核心组" }],
    baselines: [{ name: "eagle-1071", description: "V20 桌面专业版交付分支" }],
    webhookEndpoints: [
      {
        url: "https://hooks.uniontech.com/crp/desktop-core",
        secret: "real-webhook-secret-not-from-seed",
      },
    ],
  };
}

test("纯种子库判定为种子数据，并指出命中的表与值", () => {
  const findings = detectSeedData(pureSeedSnapshot());

  assert.equal(hasDecisiveFinding(findings), true, "纯种子库必须被拒绝启动");

  const tables = findings.filter((item) => item.decisive).map((item) => item.table);
  assert.deepEqual(tables.sort(), ["app_user", "webhook_endpoint"]);

  const users = findings.find((item) => item.table === "app_user");
  assert.ok(users, "必须报出 app_user 这条");
  assert.deepEqual([...users.values].sort(), [...SEED_USER_EMAILS].sort());
});

test("真实库通过：真实工作区名与真实基线名都不算种子特征", () => {
  const findings = detectSeedData(realSnapshot());

  assert.equal(hasDecisiveFinding(findings), false, "真实库不能被拒绝启动");
  assert.deepEqual(findings, [], "真实库不该报出任何种子特征");
});

test("只有种子形状的工作区与基线、没有占位凭据时，只报证据、不拒绝启动", () => {
  // 场景：有人把种子账号删了（或换成了真实哈希），但演示工作区与基线还在。
  // 这不是「纯种子库」，拒绝启动会挡住一个已经清理过一半的部署；但要让人看见。
  const snapshot = realSnapshot();
  snapshot.workspaces = SEED_WORKSPACES.map((item) => ({ ...item }));
  snapshot.baselines = SEED_BASELINES.map((item) => ({ ...item }));

  const findings = detectSeedData(snapshot);

  assert.equal(hasDecisiveFinding(findings), false, "没有占位凭据就不算决定性特征");
  assert.deepEqual(
    findings.map((item) => item.table).sort(),
    ["baseline", "workspace"],
    "工作区与基线要作为证据报出来",
  );
});

test("种子用户被换成真实哈希后，占位 Webhook 密钥仍然能判定为种子数据", () => {
  const snapshot = realSnapshot();
  snapshot.webhookEndpoints = [
    { url: "https://hooks.example.com/crp/system-apps", secret: `${SEED_WEBHOOK_SECRET_PREFIX}system-apps` },
  ];

  assert.equal(hasDecisiveFinding(detectSeedData(snapshot)), true);
});

test("失败信息可读：写清命中的表、具体值与清理办法", () => {
  const report = formatSeedReport(detectSeedData(pureSeedSnapshot()));

  assert.match(report, /拒绝启动/);
  assert.match(report, /app_user/);
  assert.match(report, /admin@uniontech\.com/);
  assert.match(report, /webhook_endpoint/);
  assert.match(report, /db:seed/, "要告诉人这是怎么进来的");
  assert.match(report, /RUNBOOK/, "要指到清理办法");
});

test("指纹常量与 prisma/seed.ts 一致：种子改了而自检没跟上时，这条会失败", () => {
  const seedSource = readFileSync(join(process.cwd(), "prisma/seed.ts"), "utf8");

  for (const value of [
    SEED_PASSWORD_HASH_PREFIX,
    SEED_WEBHOOK_SECRET_PREFIX,
    ...SEED_USER_EMAILS,
    ...SEED_WORKSPACES.flatMap((item) => [item.slug, item.name]),
    ...SEED_BASELINES.flatMap((item) => [item.name, item.description]),
  ]) {
    assert.ok(seedSource.includes(value), `prisma/seed.ts 里找不到指纹值「${value}」，自检已经过期`);
  }
});
