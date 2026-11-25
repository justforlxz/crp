/**
 * 功能组：提测记录与提测详情（FUNC-03 ~ FUNC-09、FUNC-31）。
 *
 * 这一组把「页签计数、搜索、详情四格、导出」放在数据层断言：页面拿到的就是这些值，
 * 页面画错是界面组的事。凡是还没实现的页面结构（空态里的「清除筛选」、`.risk` 风险框），
 * 断言写成「按原型该有的样子」，现在就是红的 —— 用例集描述的是新原型，不迁就现状。
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { after, before } from "node:test";

import { classTokensOfSource } from "../../../scripts/check-modules";
import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectContains, expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac03";
const PROJECT_KEY = `${PREFIX}-desktop`;
const PROJECT_NAME = `${PREFIX} 桌面专业版`;

/** 12 条提测，状态覆盖五个页签。 */
const STATUSES = [
  "pending",
  "pending",
  "pending",
  "dispatching",
  "dispatching",
  "building",
  "building",
  "building",
  "success",
  "success",
  "partial_failure",
  "failed",
] as const;

let fixture: Fixture | null = null;
let projectId = "";
const releaseIds: string[] = [];

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  projectId = await fixture.project({ key: PROJECT_KEY, name: PROJECT_NAME });

  for (const [index, status] of STATUSES.entries()) {
    releaseIds.push(
      await fixture.release({
        projectId,
        version: `${PREFIX}-${String(index)}.0.0`,
        status,
        createdAt: new Date(2026, 10, 10, 8, index),
      }),
    );
  }
});

after(async () => {
  await fixture?.cleanup();
  await disconnect();
});

acceptanceWithEnv("FUNC-03", FIXTURE_ENV, async () => {
  const { loadReleaseList, RELEASE_STATUS_TABS } = await import("../../../lib/releases");
  const workspaceId = fixture!.workspaceId;

  for (const tab of RELEASE_STATUS_TABS) {
    const page = await loadReleaseList({ workspaceId, tab, projectId });

    expectEqual(
      "FUNC-03",
      `页签「${tab}」的计数与实际行数`,
      page.counts[tab],
      page.rows.length,
    );
  }

  const all = await loadReleaseList({ workspaceId, tab: "all", projectId });
  expectEqual("FUNC-03", "「全部」页签的计数", STATUSES.length, all.counts.all);
});

acceptanceWithEnv("FUNC-04", FIXTURE_ENV, async () => {
  const { loadReleaseList } = await import("../../../lib/releases");
  const workspaceId = fixture!.workspaceId;
  const keyword = "桌面专业版";

  const page = await loadReleaseList({ workspaceId, tab: "all", keyword });

  expectTrue(
    "FUNC-04",
    "搜索命中的每一行都属于该项目的名称",
    `每行 projectName 含「${keyword}」`,
    page.rows.every((row) => row.projectName.includes(keyword)),
  );
  expectEqual("FUNC-04", "命中的条数（共 N 条）", STATUSES.length, page.rows.length);
  expectEqual("FUNC-04", "命中的条数（计数与行数一致）", page.counts.all, page.rows.length);
});

acceptanceWithEnv("FUNC-05", FIXTURE_ENV, async () => {
  const { loadReleaseList } = await import("../../../lib/releases");
  const workspaceId = fixture!.workspaceId;

  const page = await loadReleaseList({
    workspaceId,
    tab: "all",
    keyword: `${PREFIX}-不存在的关键词`,
  });

  expectEqual("FUNC-05", "无结果时的行数", 0, page.rows.length);
  expectEqual("FUNC-05", "无结果时的计数", 0, page.counts.all);

  // 空态要能清除筛选，而不是只写一句话。原型 `.empty` 里是「标题 + 说明 + 清除筛选」三件套。
  const pageSource = source("app/(app)/releases/page.tsx");
  const tokens = classTokensOfSource(pageSource);

  expectTrue(
    "FUNC-05",
    "空态用 `.empty` / `.empty-t` / `.empty-d` 三个模块",
    "三个 class 都出现在提测记录页",
    ["empty", "empty-t", "empty-d"].every((token) => tokens.has(token)),
  );
  expectContains("FUNC-05", "空态里的清除筛选项", "清除筛选", pageSource);
});

acceptanceWithEnv("FUNC-06", FIXTURE_ENV, async () => {
  const { loadReleaseDetail, loadReleaseList } = await import("../../../lib/releases");
  const workspaceId = fixture!.workspaceId;

  const list = await loadReleaseList({ workspaceId, tab: "all", projectId });
  const first = list.rows[0];

  if (first === undefined) {
    throw new Error("夹具里没有提测记录，先确认 before() 是否跑过");
  }

  const detail = await loadReleaseDetail(first.id);

  expectEqual("FUNC-06", "点行进入的那条提测的 ID", first.id, detail.releaseId);
  expectEqual("FUNC-06", "详情里的版本与列表同一行", first.version, detail.version);
  expectEqual("FUNC-06", "详情里的项目名与列表同一行", first.projectName, detail.project.name);
});

acceptanceWithEnv("FUNC-07", FIXTURE_ENV, async () => {
  const { loadReleaseDetail, releaseStatusLabel } = await import("../../../lib/releases");

  const releaseId = await fixture!.release({
    projectId,
    version: `${PREFIX}-summary.0`,
    status: "success",
    crpTopicId: `${PREFIX}-topic-1`,
  });

  // 有 Topic 的提测会去读 CRP 工作流进度；给一个只回一条 workflow/info 的假网络，
  // 免得「CRP 连不上」被误认成「概要条读不出来」。
  const network = {
    crpBaseUrl: "https://crp.example.test/api",
    crpToken: "acceptance-injected-token",
    crpFetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ TopicID: 1, WorkProgress: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  };

  const detail = await loadReleaseDetail(releaseId, {
    network,
    crpBaseUrl: "https://crp.example.test/api",
  });

  expectEqual("FUNC-07", "第一格「提测记录」", `${PREFIX}-summary.0`, detail.version);
  expectEqual("FUNC-07", "第二格「状态」", releaseStatusLabel("success"), releaseStatusLabel(detail.status));
  expectEqual("FUNC-07", "第三格「基线」", `${PREFIX}-baseline`, detail.project.baselineName);
  expectEqual("FUNC-07", "第四格「CRP 主题」", `${PREFIX}-topic-1`, detail.crpTopicId);
});

acceptanceTodo(
  "FUNC-08",
  "风险框是界面 v2 的 `.risk` 模块，当前详情页没有这个结构；数据侧也读不到快照状态（`ReleaseDetailPackage` 不含 status）。等 MKACG-984 补完详情页与快照状态读取后，按「有失败包渲染 .risk、全成功不渲染且不留空容器」断言",
);

acceptanceTodo(
  "FUNC-09",
  "状态时间线要的三个时间点（创建 / 投递完成 / 结束）现在没有读取入口：`ReleaseDetail` 只有 `createdAt`，不含 `submittedAt` / `finishedAt`。等 MKACG-984 补完时间线数据后按 `.tl-item` + `.is-cur` 断言",
);

acceptanceWithEnv("FUNC-31", FIXTURE_ENV, async () => {
  const { buildSnapshotCsv, loadReleaseDetail } = await import("../../../lib/releases");

  const releaseId = await fixture!.release({
    projectId,
    version: `${PREFIX}-export.0`,
    snapshots: [
      { packageName: `${PREFIX}-pkg-a`, branch: "develop/eagle", commitSha: "a".repeat(40) },
      { packageName: `${PREFIX}-pkg-b`, branch: "develop/eagle", commitSha: "b".repeat(40) },
    ],
  });

  const detail = await loadReleaseDetail(releaseId);
  const csv = buildSnapshotCsv(detail.packages);
  const lines = csv.split("\r\n").filter((line) => line.trim() !== "");

  expectEqual(
    "FUNC-31",
    "导出的行数（表头 + 每个软件一行）",
    detail.packages.length + 1,
    lines.length,
  );

  for (const item of detail.packages) {
    expectContains("FUNC-31", `导出内容含软件包 ${item.packageName}`, item.packageName, csv);
    expectContains("FUNC-31", `导出内容含提交号 ${item.commitSha}`, item.commitSha, csv);
  }
});

acceptanceTodo(
  "FUNC-32",
  "两个取消入口都要真的调 CRP 放弃主题（`cancelPlatformRelease` / `abandonReleaseTopic` 的 network 注入），需要 CRP 沙箱；本仓库 `tests/release-cancel.test.ts`、`tests/release-abandon.test.ts` 用假 CRP 覆盖了同一分支",
);
