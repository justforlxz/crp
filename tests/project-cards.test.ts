/**
 * 项目页与项目经理页的卡片网格（MKACG-971）。
 *
 * 锁住的是「卡片不是表格」这条硬约束在当前层的可验证部分：
 *
 * - 项目以 `.project-grid` 里的 `.project-card` 呈现，软件包构成用 `.project-software-chips`
 *   的胶囊表达，数量与清单一致；依赖环用红色 pill 标出来，空清单写「尚未添加软件包」；
 * - 项目经理以 `.manager-grid` 里的 `.manager-card` 呈现，一张卡一个人；
 * - 没有数据时渲染 `.empty`，不崩、不留空壳；
 * - 项目名搜索是纯函数：大小写不敏感、去首尾空白、关键字为空时原样返回。
 *
 * 「页面上有没有 `<table>`」要真浏览器看 DOM，由验收在页面上确认，不在这里伪造。
 */

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ManagerGrid, type ManagerCardData } from "../app/(app)/managers/managerGrid";
import { filterProjectsByName } from "../app/(app)/projects/filter";
import { ProjectGrid } from "../app/(app)/projects/projectGrid";
import type { ProjectCard } from "../lib/projects";

function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/** 数一段 HTML 里出现了几次某个 class：只数 `class="…"` 里与它逐字相同的 token。 */
function countClass(html: string, name: string): number {
  let total = 0;

  for (const match of html.matchAll(/class="([^"]*)"/gu)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token === name) {
        total += 1;
      }
    }
  }

  return total;
}

/** 一份项目卡片数据，默认清单为空；测哪一项就覆盖哪一项。 */
function project(overrides: Partial<ProjectCard> & { name: string }): ProjectCard {
  const { name, ...rest } = overrides;

  return {
    id: `project-${name}`,
    key: "uos-main",
    description: "统信桌面操作系统主线版本",
    manager: { id: "manager-1", name: "林小志" },
    baseline: { id: "baseline-1", name: "eagle-1072", syncedAt: new Date("2026-11-24T10:00:00Z") },
    updatedAt: new Date("2026-11-24T10:20:15Z"),
    software: { count: 0, dependencyCount: 0, order: [], cycle: null, entries: [] },
    ...rest,
    name,
  };
}

function chip(name: string, deps: string[] = []) {
  return {
    packageName: name,
    trackedBranch: "master",
    upstreamNames: deps,
    lastSubmittedCommit: null,
  };
}

function manager(overrides: Partial<ManagerCardData> & { name: string }): ManagerCardData {
  return {
    id: `manager-${overrides.name}`,
    userId: null,
    projectCount: 0,
    ...overrides,
  };
}

test("按项目名过滤：片段命中、大小写不敏感、清空后恢复", () => {
  const projects = [
    { name: "UOS 主线" },
    { name: "教育行业版" },
    { name: "uos-edu" },
  ];

  assert.deepEqual(
    filterProjectsByName(projects, "uos").map((item) => item.name),
    ["UOS 主线", "uos-edu"],
  );
  assert.deepEqual(
    filterProjectsByName(projects, "  edu  ").map((item) => item.name),
    ["uos-edu"],
  );
  assert.deepEqual(
    filterProjectsByName(projects, "").map((item) => item.name),
    ["UOS 主线", "教育行业版", "uos-edu"],
  );
  assert.deepEqual(filterProjectsByName(projects, "不存在的项目"), []);
});

test("项目列表是网格里的卡片，不是表格行", () => {
  const html = htmlOf(
    createElement(ProjectGrid, {
      projects: [project({ name: "UOS 主线" }), project({ name: "教育行业版" })],
      keyword: "",
      query: "?workspace=desktop-core",
    }),
  );

  assert.equal(countClass(html, "project-grid"), 1);
  assert.equal(countClass(html, "project-card"), 2);
  assert.doesNotMatch(html, /<table/);
});

test("软件包胶囊数量与项目清单一致，并带顺序号与依赖说明", () => {
  const html = htmlOf(
    createElement(ProjectGrid, {
      projects: [
        project({
          name: "UOS 主线",
          software: {
            count: 3,
            dependencyCount: 1,
            order: ["kwayland", "kwin", "dde-dock"],
            cycle: null,
            entries: [chip("kwayland"), chip("kwin", ["kwayland"]), chip("dde-dock")],
          },
        }),
      ],
      keyword: "",
      query: "",
    }),
  );

  assert.equal(countClass(html, "project-software-chips"), 1);
  assert.match(html, /<i>1<\/i>kwayland/u);
  assert.match(html, /<i>2<\/i>kwin/u);
  assert.match(html, /<i>3<\/i>dde-dock/u);
  assert.match(html, /依赖 1 项/u);
  assert.match(html, /无依赖/u);
  assert.doesNotMatch(html, /尚未添加软件包/u);
});

test("清单为空的项目写「尚未添加软件包」，不留空胶囊区", () => {
  const html = htmlOf(
    createElement(ProjectGrid, { projects: [project({ name: "空项目" })], keyword: "", query: "" }),
  );

  assert.equal(countClass(html, "project-software-chips"), 1);
  assert.match(html, /尚未添加软件包/u);
});

test("依赖有环时用红色 pill 点名环上的包", () => {
  const html = htmlOf(
    createElement(ProjectGrid, {
      projects: [
        project({
          name: "有环项目",
          software: {
            count: 2,
            dependencyCount: 2,
            order: ["kwin", "kwayland"],
            cycle: ["kwin", "kwayland", "kwin"],
            entries: [chip("kwin", ["kwayland"]), chip("kwayland", ["kwin"])],
          },
        }),
      ],
      keyword: "",
      query: "",
    }),
  );

  assert.match(html, /class="pill p-red"/u);
  assert.match(html, /kwin → kwayland → kwin/u);
});

test("没有项目时渲染空态，有关键字时说明没有匹配", () => {
  const empty = htmlOf(createElement(ProjectGrid, { projects: [], keyword: "", query: "" }));
  assert.equal(countClass(empty, "project-grid"), 0);
  assert.equal(countClass(empty, "empty"), 1);
  assert.match(empty, /还没有项目/u);

  const noMatch = htmlOf(createElement(ProjectGrid, { projects: [], keyword: "uos", query: "" }));
  assert.equal(countClass(noMatch, "empty"), 1);
  assert.match(noMatch, /没有名称含「uos」的项目/u);
});

test("项目经理是网格里的一张卡一个人", () => {
  const html = htmlOf(
    createElement(ManagerGrid, {
      managers: [
        manager({ name: "林小志", projectCount: 2, userId: "user-1" }),
        manager({ name: "郭垚", projectCount: 1 }),
      ],
    }),
  );

  assert.equal(countClass(html, "manager-grid"), 1);
  assert.equal(countClass(html, "manager-card"), 2);
  assert.match(html, /林小志/u);
  assert.match(html, /2 个项目/u);
  assert.match(html, /已绑定平台账号/u);
  assert.match(html, /未绑定平台账号/u);
  assert.doesNotMatch(html, /<table/);
});

test("没有项目经理时渲染空态", () => {
  const html = htmlOf(createElement(ManagerGrid, { managers: [] }));

  assert.equal(countClass(html, "manager-grid"), 0);
  assert.equal(countClass(html, "empty"), 1);
  assert.match(html, /还没有项目经理/u);
});
