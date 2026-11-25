/**
 * 功能组：创建提测向导（FUNC-17 ~ FUNC-24、FUNC-34）。
 *
 * 向导的三步页面由 MKACG-983 重做，所以「第几步顺序」「经理与项目联动」这两条留 TODO；
 * 其余几条都是数据与规则层的，现在就能验：
 *
 * - 全部软件都进提测，没有「只提一部分」的入口；
 * - 顺序来自依赖，不由调用方给；
 * - 「有更新 / 无变化」只作提示，不影响是否纳入；
 * - 自定义版本只覆盖提测版本，代码版本照旧。
 */

import "dotenv/config";

import { after, before } from "node:test";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { db, disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac19";

/** 三个包：kwin → dde-dock（dock 依赖 kwin），glibc 独立。 */
const KWIN = `${PREFIX}-kwin`;
const DOCK = `${PREFIX}-dde-dock`;
const GLIBC = `${PREFIX}-glibc`;

const SHA = {
  [KWIN]: "1".repeat(40),
  [DOCK]: "2".repeat(40),
  [GLIBC]: "3".repeat(40),
} as const;

let fixture: Fixture | null = null;
let projectId = "";

/** 读项目全貌；项目不存在时直接失败，避免后面的断言读到一个 null。 */
async function loadProject(): Promise<NonNullable<Awaited<ReturnType<typeof importProject>>>> {
  const project = await importProject(projectId);

  if (project === null) {
    throw new Error(`夹具里的项目 ${projectId} 读不到，先确认 before() 是否跑过`);
  }

  return project;
}

async function importProject(id: string) {
  const { loadReleaseProject } = await import("../../../lib/releases");
  return loadReleaseProject(id);
}

/** 代码版本：与包名绑定，断言时不用猜顺序。 */
function codeVersionOf(packageName: string): string {
  return `4:${packageName}-1`;
}

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  projectId = await fixture.project({ key: `${PREFIX}-p`, name: `${PREFIX} 项目` });

  const kwin = await fixture.package({ name: KWIN });
  const dock = await fixture.package({ name: DOCK });
  const glibc = await fixture.package({ name: GLIBC });

  // 「无变化」= 上次提测的 Commit 与本次相同；另外两个是「有更新」。
  await fixture.addSoftware(projectId, kwin, { lastSubmittedCommit: SHA[KWIN] });
  await fixture.addSoftware(projectId, dock, { lastSubmittedCommit: null });
  await fixture.addSoftware(projectId, glibc, { lastSubmittedCommit: "f".repeat(40) });

  await fixture.dependencies(dock, [kwin]);
});

after(async () => {
  await fixture?.cleanup();
  await disconnect();
});

acceptanceTodo(
  "FUNC-17",
  "三步顺序与每步底部按钮文案在向导页上（`.steps` / `.step` 与 design.md 第八节的按钮表），当前页面还是旧的单页表单。等 MKACG-983 重做后按步断言",
);

acceptanceTodo(
  "FUNC-18",
  "「切换项目经理后项目下拉只剩该经理名下项目」是向导第 1 步的联动行为，属于 MKACG-983 的 `.form-row2`。数据侧 `loadReleaseProjectChoices` 已有 managerId 字段，页面接上后即可断言",
);

acceptanceWithEnv("FUNC-19", FIXTURE_ENV, async () => {
  const project = await loadProject();

  expectEqual("FUNC-19", "投递顺序覆盖的软件包数", 3, project.readiness.packageCount);
  expectEqual(
    "FUNC-19",
    "投递顺序里的包集合（清单全量，没有可勾选排除的余地）",
    [KWIN, DOCK, GLIBC].sort(),
    [...project.readiness.order].sort(),
  );
  expectEqual("FUNC-19", "项目清单行数", 3, project.packages.length);
});

acceptanceWithEnv("FUNC-20", FIXTURE_ENV, async () => {
  const { createRelease } = await import("../../../lib/releases");

  const project = await loadProject();
  const order = project.readiness.order;

  expectTrue(
    "FUNC-20",
    "上游 kwin 排在依赖它的 dde-dock 之前",
    `kwin 的下标 < dde-dock 的下标（实际顺序 ${order.join(" → ")}）`,
    order.indexOf(KWIN) < order.indexOf(DOCK),
  );

  // 调用方按反序提交也不改变顺序：顺序来自依赖，页面上的「顺序列」没有拖动入口。
  const created = await createRelease(
    {
      projectId,
      version: `${PREFIX}-order.0`,
      description: null,
      packages: [GLIBC, DOCK, KWIN].map((packageName) => ({
        packageName,
        branch: "develop/eagle",
        commitSha: SHA[packageName as keyof typeof SHA],
        customTag: null,
      })),
    },
    {
      createdById: fixture!.userId,
      reader: { readCodeVersion: (_repo, sha) => Promise.resolve(`code-${sha.slice(0, 4)}`) },
    },
  );

  expectEqual(
    "FUNC-20",
    "新建提测里固化的顺序（反序提交也一样）",
    order,
    created.order,
  );
});

acceptanceWithEnv("FUNC-21", FIXTURE_ENV, async () => {
  const { createRelease } = await import("../../../lib/releases");

  // 前一条用例的 `createRelease` 会把 `lastSubmittedCommit` 刷成本次的 Commit。
  // 这里按本条要验的三种情形重设，避免用例之间靠执行顺序互相影响。
  const prisma = await db();
  const software = await prisma.projectSoftware.findMany({
    where: { projectId },
    select: { id: true, package: { select: { name: true } } },
  });
  const lastSubmitted: Record<string, string | null> = {
    [KWIN]: SHA[KWIN],
    [DOCK]: null,
    [GLIBC]: "f".repeat(40),
  };

  for (const row of software) {
    await prisma.projectSoftware.update({
      where: { id: row.id },
      data: { lastSubmittedCommit: lastSubmitted[row.package.name] ?? null },
    });
  }

  const created = await createRelease(
    {
      projectId,
      version: `${PREFIX}-changes.0`,
      description: null,
      packages: [KWIN, DOCK, GLIBC].map((packageName) => ({
        packageName,
        branch: "develop/eagle",
        commitSha: SHA[packageName as keyof typeof SHA],
        customTag: null,
      })),
    },
    {
      createdById: fixture!.userId,
      reader: { readCodeVersion: (_repo, sha) => Promise.resolve(`code-${sha.slice(0, 4)}`) },
    },
  );

  expectEqual("FUNC-21", "本次提测的软件总数（含无变化的）", 3, created.summary.total);
  expectEqual("FUNC-21", "其中「有更新」的个数", 2, created.summary.changed);
  expectEqual("FUNC-21", "快照行数（无变化的不被排除）", 3, created.snapshots.length);

  const unchanged = created.snapshots.find((item) => item.packageName === KWIN);
  expectEqual("FUNC-21", "无变化的包的 changed 标记", false, unchanged?.changed);
});

acceptanceWithEnv("FUNC-22", FIXTURE_ENV, async () => {
  const { buildSnapshotPlan } = await import("../../../lib/releases");

  const custom = buildSnapshotPlan({
    packageName: KWIN,
    branch: "develop/eagle",
    commitSha: SHA[KWIN],
    codeVersion: codeVersionOf(KWIN),
    repoVersion: null,
    customTag: "5.0.0-custom",
    lastSubmittedCommit: SHA[KWIN],
  });

  expectEqual("FUNC-22", "填了自定义 Tag 时的提测版本", "5.0.0-custom", custom.releaseVersion);
  expectEqual("FUNC-22", "代码版本不被自定义 Tag 覆盖", codeVersionOf(KWIN), custom.codeVersion);
  expectEqual("FUNC-22", "Commit 未变时 changed", false, custom.changed);

  const restored = buildSnapshotPlan({
    packageName: KWIN,
    branch: "develop/eagle",
    commitSha: SHA[KWIN],
    codeVersion: codeVersionOf(KWIN),
    repoVersion: null,
    customTag: "   ",
    lastSubmittedCommit: "f".repeat(40),
  });

  expectEqual("FUNC-22", "恢复默认后回到 changelog 版本", codeVersionOf(KWIN), restored.releaseVersion);
  expectEqual("FUNC-22", "Commit 变了时 changed", true, restored.changed);
});

acceptanceWithEnv("FUNC-23", FIXTURE_ENV, async () => {
  const { createRelease, loadReleaseDetail } = await import("../../../lib/releases");

  const project = await loadProject();
  const created = await createRelease(
    {
      projectId,
      version: `${PREFIX}-confirm.0`,
      description: null,
      packages: project.packages.map((item) => ({
        packageName: item.packageName,
        branch: "release/acceptance",
        commitSha: SHA[item.packageName as keyof typeof SHA],
        customTag: null,
      })),
    },
    {
      createdById: fixture!.userId,
      reader: { readCodeVersion: (_repo, sha) => Promise.resolve(`code-${sha.slice(0, 4)}`) },
    },
  );

  const detail = await loadReleaseDetail(created.id);
  const byName = new Map(detail.packages.map((item) => [item.packageName, item]));

  expectEqual("FUNC-23", "确认表的行数", project.packages.length, detail.packages.length);

  for (const item of project.packages) {
    const row = byName.get(item.packageName);

    expectEqual("FUNC-23", `${item.packageName} 的分支`, "release/acceptance", row?.branch);
    expectEqual(
      "FUNC-23",
      `${item.packageName} 的 Commit`,
      SHA[item.packageName as keyof typeof SHA],
      row?.commitSha,
    );
    expectEqual(
      "FUNC-23",
      `${item.packageName} 的代码版本`,
      `code-${SHA[item.packageName as keyof typeof SHA].slice(0, 4)}`,
      row?.codeVersion,
    );
  }
});

acceptanceWithEnv("FUNC-24", FIXTURE_ENV, async () => {
  const { createGerritReader } = await import("../../../lib/releases");
  const { GerritError } = await import("../../../lib/integrations/gerrit");

  const failing = {
    listBranches: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    listCommits: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    getCommit: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    readChangelog: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    listProjects: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    resolveTag: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
    resolveTagCommit: () => Promise.reject(new GerritError("连不上 Gerrit（验收用）")),
  };

  const reader = createGerritReader(failing);

  // 「下拉禁用并显示原因」的前提是：查询失败必须抛错并带着原因，而不是回一个空列表
  // —— 空列表会被界面当成「这个仓库没有分支」，于是下拉可以选、但什么也选不到。
  let message = "";
  let resolved: string[] | null = null;

  try {
    resolved = await reader.listBranches("deepin-kde/kwin");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expectTrue(
    "FUNC-24",
    "Gerrit 查询失败时不返回选项列表",
    "抛错，而不是返回 []",
    resolved === null,
  );
  expectEqual(
    "FUNC-24",
    "抛出的原因原样带着「连不上」",
    true,
    message.includes("连不上 Gerrit"),
  );
});

acceptanceWithEnv("FUNC-34", FIXTURE_ENV, async () => {
  const { createGerritClient, isCommitSha } = await import("../../../lib/integrations/gerrit");

  const requested: string[] = [];
  const changelog = [
    `${KWIN} (${codeVersionOf(KWIN)}) unstable; urgency=medium`,
    "",
    "  * 验收用的变更条目",
    "",
    " -- Acceptance <acceptance@example.test>  Mon, 01 Jan 2024 00:00:00 +0800",
    "",
  ].join("\n");

  const client = createGerritClient(
    {
      baseUrl: "https://gerrit.example.test",
      username: "acceptance",
      httpPassword: "acceptance-not-a-real-credential",
      timeoutMs: 5_000,
    },
    {
      fetch: (input) => {
        requested.push(input.toString());

        // gitiles 的 `format=TEXT` 返回 base64。
        return Promise.resolve(
          new Response(Buffer.from(changelog, "utf8").toString("base64"), { status: 200 }),
        );
      },
    },
  );

  const shortSha = "a1b2c3d";
  const result = await client.readChangelog("deepin-kde/kwin", shortSha);

  expectTrue(
    "FUNC-34",
    "7 位短 SHA 被当成提交号，而不是被补成 refs/heads/<sha>",
    "请求路径里含 /+/a1b2c3d/ 且不含 refs/heads/a1b2c3d",
    requested.some(
      (url) => url.includes(`/+/${shortSha}/`) && !url.includes(`refs/heads/${shortSha}`),
    ),
  );
  expectEqual("FUNC-34", "短 SHA 读到的代码版本", codeVersionOf(KWIN), result.entry.version);
  expectEqual("FUNC-34", "isCommitSha 认 7 位十六进制", true, isCommitSha(shortSha));
});
