/**
 * Gerrit 与 gitiles 客户端的真实连通验证。
 *
 * 用真实仓库跑一遍本节点的四个能力：列分支、列提交、读单条提交、读并解析 changelog，
 * 再对不存在的仓库确认错误可读。凭据只从环境变量来，脚本不打印任何凭据内容。
 *
 * 运行方式（凭据由环境注入，不要写进仓库）：
 *
 *   GERRIT_USERNAME=... GERRIT_HTTP_PASSWORD=... pnpm tsx scripts/verify-gerrit.ts
 *
 * 也可以写在 `.env`（已被 gitignore 忽略）里，脚本会用 dotenv 读。
 */

import "dotenv/config";

import {
  createGerritClient,
  GerritError,
  GerritNotFoundError,
  readGerritConfig,
} from "../lib/integrations/gerrit";

/** issue 里已确认可用的两个仓库与分支，正好构成 kwin 依赖 wayland 的链条。 */
const TARGETS = [
  { project: "deepin-kde/kwin", branch: "develop/snipe" },
  { project: "deepin-kde/wayland", branch: "develop/eagle" },
];

/** AC1 点名的组合，单独复核一次。 */
const AC1_TARGET = { project: "deepin-kde/kwin", branch: "develop/eagle" };

const MISSING_PROJECT = "deepin-kde/no-such-repo-for-verification";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  for (const line of detail.split("\n")) {
    console.log(`      ${line}`);
  }
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? "";
}

async function main(): Promise<void> {
  const client = createGerritClient(readGerritConfig());

  // 1. 列分支：AC1
  for (const target of [AC1_TARGET, ...TARGETS]) {
    const label = `${target.project} @ ${target.branch}`;
    try {
      const branches = await client.listBranches(target.project);
      const matched = branches.find((item) => item.branch === target.branch);

      record(
        `listBranches 查回 ${label}`,
        matched !== undefined,
        matched
          ? `共 ${branches.length} 个分支；${matched.ref} 指向 ${matched.revision}`
          : `共 ${branches.length} 个分支，但没有 ${target.branch}`,
      );
    } catch (error) {
      record(`listBranches 查回 ${label}`, false, `请求失败：${firstLine(String(error))}`);
    }
  }

  // 2. 列提交、读单条提交、读 changelog：按仓库逐个跑
  for (const target of TARGETS) {
    const label = `${target.project} @ ${target.branch}`;

    try {
      const commits = await client.listCommits(target.project, target.branch, 5);
      record(
        `listCommits 取 ${label} 最近 5 条`,
        commits.length > 0,
        commits.length > 0
          ? commits
              .map((commit) => `${commit.sha.slice(0, 12)}  ${firstLine(commit.message)}`)
              .join("\n")
          : "没有取到任何提交",
      );
    } catch (error) {
      record(`listCommits 取 ${label}`, false, `请求失败：${firstLine(String(error))}`);
    }

    try {
      const branches = await client.listBranches(target.project);
      const head = branches.find((item) => item.branch === target.branch);

      if (!head || head.revision === "") {
        record(`getCommit 读 ${label} 分支头提交`, false, "分支头提交 sha 为空");
        continue;
      }

      const commit = await client.getCommit(target.project, head.revision);
      record(
        `getCommit 读 ${label} 分支头提交`,
        commit.sha === head.revision,
        `${commit.sha}  ${firstLine(commit.message)}\n提交者 ${commit.committer.name} <${commit.committer.email}> ${commit.committer.time}`,
      );
    } catch (error) {
      record(`getCommit 读 ${label} 分支头提交`, false, `请求失败：${firstLine(String(error))}`);
    }

    try {
      const { entry, text } = await client.readChangelog(target.project, target.branch);
      const head = text.split("\n").slice(0, 3).join("\n");

      record(
        `readChangelog 解析 ${label} 首条版本号`,
        entry.version !== "" && entry.packageName !== "",
        `包名 ${entry.packageName}，版本 ${entry.version}，发行版 ${entry.distribution}，时间 ${entry.date}\nchangelog 原文前 3 行：\n${head}`,
      );
    } catch (error) {
      record(`readChangelog 解析 ${label} 首条版本号`, false, `解析失败：${firstLine(String(error))}`);
    }
  }

  // 3. 不存在的仓库：AC4，必须给出可读错误
  try {
    await client.listBranches(MISSING_PROJECT);
    record(`不存在的仓库 ${MISSING_PROJECT} 返回可读错误`, false, "居然成功了，没有报错");
  } catch (error) {
    const readable = error instanceof GerritNotFoundError;
    record(
      `不存在的仓库 ${MISSING_PROJECT} 返回可读错误`,
      readable,
      readable ? `抛出 GerritNotFoundError：${(error as Error).message}` : `抛出了其他错误：${String(error)}`,
    );
  }

  try {
    await client.readChangelog(MISSING_PROJECT, "develop/eagle");
    record(`不存在仓库的 changelog 返回可读错误`, false, "居然成功了，没有报错");
  } catch (error) {
    const readable = error instanceof GerritNotFoundError;
    record(
      `不存在仓库的 changelog 返回可读错误`,
      readable,
      readable ? `抛出 GerritNotFoundError：${(error as Error).message}` : `抛出了其他错误：${String(error)}`,
    );
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项。`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof GerritError) {
    console.error(`验证无法开始：${error.message}`);
  } else {
    console.error(`验证无法开始：${String(error)}`);
  }
  process.exitCode = 1;
});
