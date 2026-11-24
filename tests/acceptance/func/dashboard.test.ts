/**
 * 功能组：工作台（FUNC-01、FUNC-02）。
 *
 * 断言打在 `loadDashboard` 这一层，也就是页面真正取数的地方：页面只负责把数字画出来，
 * 「数得对不对」由这里负责。换一套配色、换一种排版都不该让这两条用例变红。
 */

import "dotenv/config";

import { after, before } from "node:test";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac02";

let fixture: Fixture | null = null;
let projectId = "";

/** 8 条创建时间乱序的提测：用来验「最近提测按创建时间倒序、最多 5 条」。 */
const CREATED_AT = [
  "2026-11-18T09:00:00Z",
  "2026-11-15T09:00:00Z",
  "2026-11-19T09:00:00Z",
  "2026-11-14T09:00:00Z",
  "2026-11-17T09:00:00Z",
  "2026-11-13T09:00:00Z",
  "2026-11-16T09:00:00Z",
  "2026-11-12T09:00:00Z",
];

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  projectId = await fixture.project({ key: `${PREFIX}-p`, name: `${PREFIX} 项目` });

  for (const [index, createdAt] of CREATED_AT.entries()) {
    await fixture.release({
      projectId,
      version: `${PREFIX}-${String(index)}.0.0`,
      createdAt: new Date(createdAt),
    });
  }
});

after(async () => {
  await fixture?.cleanup();
  await disconnect();
});

acceptanceTodo(
  "FUNC-01",
  "统计卡口径改成「进行中的提测 / 构建成功 / 构建失败 / 等待投递」，lib/stats 现在给的是「本周提测 / 等待构建 / 本周成功率 / 项目配置数」。等 MKACG-983 改完数据层后按新口径补断言",
);

acceptanceWithEnv("FUNC-02", FIXTURE_ENV, async () => {
  const { loadDashboard } = await import("../../../lib/stats");
  const view = await loadDashboard(fixture!.workspaceId);

  expectEqual(
    "FUNC-02",
    "最近提测的条数上限",
    5,
    view.recentReleases.length,
  );

  const times = view.recentReleases.map((row) => row.createdAt.getTime());
  const sortedDesc = [...times].sort((left, right) => right - left);
  expectTrue(
    "FUNC-02",
    "最近提测按创建时间倒序",
    `倒序排列，实际是 ${times.map((time) => new Date(time).toISOString()).join(" → ")}`,
    times.every((time, index) => time === sortedDesc[index]),
  );

  // 8 条按创建时间取最新 5 条：11-12 那条（index 7）是最旧的，必须不在结果里。
  expectEqual(
    "FUNC-02",
    "取到的版本集合（最新 5 条）",
    ["zzac02-2.0.0", "zzac02-0.0.0", "zzac02-4.0.0", "zzac02-6.0.0", "zzac02-1.0.0"].sort(),
    view.recentReleases.map((row) => row.version).sort(),
  );
});
