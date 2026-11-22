/**
 * 提测详情页挂载「构建状态」区块（A13 接线 A14）的集成测试：连真数据库，渲染到 HTML 再断言。
 *
 * 锁住的是本节点的三条硬约束：
 *
 * - 详情页挂上去的就是 A14 那个区块本身，内容与队列页同一套说法（MUST NOT 在详情页复制一份）；
 * - 区块自己查库，查库抛错时只把这一块换成一句提示，详情页其余部分照常渲染（MUST）；
 * - 区块输出原样交给页面，不在这一层改写（改写了就等于复制了一份渲染逻辑）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test, { after, before } from "node:test";

import { BuildStatusSection, renderBuildStatusBlock } from "../app/(app)/releases/[id]/buildStatusSection";
import { prisma } from "../lib/db";

const PREFIX = "zz905";
const WORKSPACE_SLUG = `${PREFIX}-workspace`;
const PROJECT_KEY = `${PREFIX}-proj`;
const RELEASE_VERSION = `${PREFIX}-1.0.0`;
const CRP_TOPIC_ID = "990505";

/** 把一段子元素渲染成静态 HTML，断言都对着渲染结果做，不对着 React 元素内部结构做。 */
function htmlOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

type Fixture = { releaseId: string };

let fixture: Fixture;

async function cleanup(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((item) => item.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  const projectIds = projects.map((item) => item.id);

  const releases = await prisma.release.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const releaseIds = releases.map((item) => item.id);

  await prisma.buildJob.deleteMany({ where: { buildTask: { releaseId: { in: releaseIds } } } });
  await prisma.buildTask.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releaseRepositoryRecord.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.releasePackageSnapshot.deleteMany({ where: { releaseId: { in: releaseIds } } });
  await prisma.release.deleteMany({ where: { id: { in: releaseIds } } });

  await prisma.projectSoftware.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.projectManager.deleteMany({ where: { workspace: { id: { in: workspaceIds } } } });
  await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.baseline.deleteMany({ where: { crpBranchId: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanup();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: `${PREFIX} 工作区` },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: `${PREFIX} 开发者`,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "developer" },
  });

  const baseline = await prisma.baseline.create({
    data: { crpBranchId: `${PREFIX}-branch`, name: `${PREFIX}-baseline` },
    select: { id: true },
  });
  const manager = await prisma.projectManager.create({
    data: { workspaceId: workspace.id, name: `${PREFIX}-manager` },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      projectManagerId: manager.id,
      baselineId: baseline.id,
      key: PROJECT_KEY,
      name: `${PREFIX} 项目`,
    },
    select: { id: true },
  });

  const release = await prisma.release.create({
    data: {
      projectId: project.id,
      version: RELEASE_VERSION,
      status: "building",
      createdById: user.id,
      crpTopicId: CRP_TOPIC_ID,
      crpBranchId: `${PREFIX}-branch`,
      crpWorkProgress: 10,
      crpWorkProgressLabel: "构建中",
      crpWorkProgressSyncedAt: new Date("2026-11-19T06:00:00Z"),
    },
    select: { id: true },
  });

  // 一个包构建成功（两个架构都成功），另一个包还没投递：两种阶段一句话都要在区块里出现。
  const built = await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: `${PREFIX}-built`,
      attempt: 1,
      branch: "develop/eagle",
      commitSha: "a".repeat(40),
      codeVersion: "1.0.0-1",
      releaseVersion: "1.0.0-1",
      status: "success",
    },
    select: { id: true },
  });
  await prisma.releasePackageSnapshot.create({
    data: {
      releaseId: release.id,
      packageName: `${PREFIX}-queued`,
      attempt: 1,
      branch: "develop/eagle",
      commitSha: "b".repeat(40),
      codeVersion: "2.0.0-1",
      releaseVersion: "2.0.0-1",
      status: "pending",
    },
  });

  const task = await prisma.buildTask.create({
    data: {
      releaseId: release.id,
      snapshotId: built.id,
      shuttleTaskId: `${PREFIX}-shuttle-task`,
      status: "success",
      lastPolledAt: new Date("2026-11-19T07:00:00Z"),
      startedAt: new Date("2026-11-19T06:30:00Z"),
      finishedAt: new Date("2026-11-19T06:50:00Z"),
    },
    select: { id: true },
  });
  await prisma.buildJob.createMany({
    data: [
      { buildTaskId: task.id, shuttleJobId: `${PREFIX}-job-amd64`, arch: "amd64", status: "success" },
      { buildTaskId: task.id, shuttleJobId: `${PREFIX}-job-arm64`, arch: "arm64", status: "success" },
    ],
  });

  fixture = { releaseId: release.id };
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("详情页挂上去的就是 A14 的区块，包名、阶段、架构状态都渲染出来（AC1）", async () => {
  const html = htmlOf(await BuildStatusSection({ releaseId: fixture.releaseId }));

  assert.match(html, /<h2[^>]*>构建状态<\/h2>/);
  // 提测整体状态与 CRP 工作流进度：与队列页同一套 `buildStatusLabel` 说法。
  assert.match(html, /提测状态：构建中/);
  assert.match(html, /10 构建中/);
  assert.match(html, new RegExp(`<code>${CRP_TOPIC_ID}</code>`));

  // 已构建完成的包：阶段「成功」、两个架构都成功、耗时 20 分钟。
  assert.match(html, new RegExp(`<code>${PREFIX}-built</code>`));
  assert.match(html, /20 分钟/);
  assert.match(html, /amd64：成功/);
  assert.match(html, /arm64：成功/);

  // 还没投递的包：阶段「待投递」，没有架构与耗时。
  assert.match(html, new RegExp(`<code>${PREFIX}-queued</code>`));
  assert.match(html, /待投递/);
});

test("区块读库抛错时只把这一块换成提示，详情页其余部分照常渲染（MUST）", async () => {
  const block = await renderBuildStatusBlock(fixture.releaseId, async () => {
    throw new Error("数据库连不上");
  });

  const html = htmlOf(
    createElement(
      "main",
      null,
      createElement("h1", null, "提测详情"),
      createElement("h2", null, "概要"),
      block,
      createElement("h2", null, "更新提测"),
    ),
  );

  // 页面其余部分还在。
  assert.match(html, /<h1>提测详情<\/h1>/);
  assert.match(html, /<h2>概要<\/h2>/);
  assert.match(html, /<h2>更新提测<\/h2>/);
  // 失败的这一块给出提示，不把错误内容漏到页面上。
  assert.match(html, /<h2[^>]*>构建状态<\/h2>/);
  assert.match(html, /构建状态暂时读不到/);
  assert.doesNotMatch(html, /数据库连不上/);
});

test("区块输出原样交给详情页，这一层不改写内容", async () => {
  const html = htmlOf(
    await renderBuildStatusBlock(fixture.releaseId, async ({ releaseId }) =>
      createElement("p", null, `区块自己的输出 ${releaseId}`),
    ),
  );

  assert.equal(html, `<p>区块自己的输出 ${fixture.releaseId}</p>`);
});
