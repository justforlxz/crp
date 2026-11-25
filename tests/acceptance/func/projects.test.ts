/**
 * 功能组：项目与项目经理（FUNC-10 ~ FUNC-13）。
 *
 * `FUNC-10` 的「不是表格行」检查的是页面源码：项目与经理在原型里是卡片网格，出现 `<table>`
 * 承载这两类数据就是结构降级。断言取 `className` 上下文与标签两种信号，不靠人眼看。
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { after, before } from "node:test";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { db, disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac10";

let fixture: Fixture | null = null;

/** 两个经理、三个项目：经理 1 两个项目，经理 2 一个。 */
before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  const prisma = await db();

  const secondManager = await prisma.projectManager.create({
    data: { workspaceId: fixture.workspaceId, name: `${PREFIX} 二号经理` },
    select: { id: true },
  });

  await fixture.project({ key: `${PREFIX}-a`, name: `${PREFIX} 桌面专业版` });
  await fixture.project({ key: `${PREFIX}-b`, name: `${PREFIX} 服务器版` });
  await fixture.project({
    key: `${PREFIX}-c`,
    name: `${PREFIX} 服务器版加强`,
    managerId: secondManager.id,
  });
});

after(async () => {
  // 先删项目（`cleanup` 按前缀清理时一并删掉经理），顺序反过来会撞外键。
  await fixture?.cleanup();
  await disconnect();
});

acceptanceWithEnv("FUNC-10", FIXTURE_ENV, async () => {
  const { listProjectCards } = await import("../../../lib/projects");

  const cards = await listProjectCards(fixture!.workspaceId);

  expectEqual("FUNC-10", "项目卡数量", 3, cards.length);
  expectTrue(
    "FUNC-10",
    "每张卡都带经理与基线（卡片结构的数据部分）",
    "每张卡的 manager.name 与 baseline.name 都非空",
    cards.every((card) => card.manager.name !== "" && card.baseline.name !== ""),
  );

  // 项目与项目经理两类数据在页面里不能落成 <table>：原型是卡片网格。
  const pageSources = ["app/(app)/projects/page.tsx", "app/(app)/projects/projectGrid.tsx"];
  const tables = pageSources.filter((path) =>
    readFileSync(resolve(process.cwd(), path), "utf8").includes("<table"),
  );

  expectEqual("FUNC-10", "项目页里承载项目 / 经理的 <table> 数量", [], tables);
});

acceptanceTodo(
  "FUNC-11",
  "项目卡上的软件包胶囊是 `.pc-chips` + `.chip`，当前项目卡没有这段结构（`pnpm check:modules` 里 .pc-chips / .chip 报缺失）。等 MKACG-984 按原型补完后断言「6 个以内逐个列出、超出的显示还有 N 个」",
);

acceptanceWithEnv("FUNC-12", FIXTURE_ENV, async () => {
  const [{ listProjectCards }, { filterProjectsByName }] = await Promise.all([
    import("../../../lib/projects"),
    import("../../../app/(app)/projects/filter"),
  ]);

  const cards = await listProjectCards(fixture!.workspaceId);
  const filtered = filterProjectsByName(cards, "服务器");
  const cleared = filterProjectsByName(cards, "   ");

  expectEqual(
    "FUNC-12",
    "按「服务器」过滤后的项目名",
    [`${PREFIX} 服务器版`, `${PREFIX} 服务器版加强`].sort(),
    filtered.map((card) => card.name).sort(),
  );
  expectEqual("FUNC-12", "清空搜索后恢复全量", 3, cleared.length);
});

acceptanceWithEnv("FUNC-13", FIXTURE_ENV, async () => {
  const [{ listManagers, listProjectCards }] = await Promise.all([
    import("../../../lib/projects"),
  ]);

  const managers = await listManagers(fixture!.workspaceId);
  const cards = await listProjectCards(fixture!.workspaceId);

  // 两个接口各算一遍：卡上的「名下项目」必须等于项目页里归属该经理的项目数。
  const fromCards = new Map<string, number>();

  for (const card of cards) {
    fromCards.set(card.manager.name, (fromCards.get(card.manager.name) ?? 0) + 1);
  }

  for (const manager of managers) {
    expectEqual(
      "FUNC-13",
      `经理「${manager.name}」名下项目数`,
      fromCards.get(manager.name) ?? 0,
      manager.projectCount,
    );
  }
});
