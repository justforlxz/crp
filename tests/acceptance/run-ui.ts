/**
 * 界面组的入口（MKACG-985）。
 *
 * 为什么包一层而不是直接 `tsx --test tests/acceptance/ui/*.test.ts`：
 *
 * 界面组要两个环境（`BASE_URL` 与 `DATABASE_URL`）。缺的时候如果照样把用例跑起来，它们会全部
 * 变成 skip —— 一轮下来退出码 0，看起来「界面组通过」，实际一条都没看。验收的人多半只看退出码，
 * 这正是用例集第七条 point 4 警告过的情形（「界面组没有环境时，必须写明未执行及原因，不能用别的
 * 组结果代替」）。所以这里在跑之前先查环境：缺就明说、以退出码 2 结束，什么用例都不跑。
 *
 * 退出码约定与仓库里其它脚本一致：
 *
 * | 码 | 含义 |
 * | --- | --- |
 * | 0 | 用例全部通过 |
 * | 1 | 有用例失败（明细在 `node --test` 的输出里） |
 * | 2 | 环境不对，什么都没查 |
 */

import "dotenv/config";

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { baseUrl, databaseUrl } from "./support/env";

const UI_DIR = resolve(process.cwd(), "tests/acceptance/ui");

/** 缺哪一项就说哪一项，并写清怎么补。两段分开写，读的人不用自己拼。 */
function reportMissing(missing: readonly string[]): never {
  console.error(`界面组未执行：缺少 ${missing.join(" 与 ")}。`);
  console.error("");
  console.error("界面组需要两个环境：");
  console.error("  BASE_URL      指向一个跑起来的实例，例如 BASE_URL=http://127.0.0.1:3000");
  console.error("  DATABASE_URL  会话按 scripts/style-check 的方式直接写库，需要一个 db:seed 过的库");
  console.error("");
  console.error("准备方式见 README 的「验收用例集」一节。没有环境时这一组不算通过，也不算失败。");
  process.exit(2);
}

function testFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(directory, name));
}

const missing: string[] = [];

if (baseUrl() === null) {
  missing.push("BASE_URL");
}

if (databaseUrl() === null) {
  missing.push("DATABASE_URL");
}

if (missing.length > 0) {
  reportMissing(missing);
}

const files = testFiles(UI_DIR);

if (files.length === 0) {
  console.error(`界面组没有用例文件：${UI_DIR}`);
  process.exit(2);
}

// 用 node 直接跑测试运行器，经 tsx 加载 TypeScript：与 `pnpm test` 同一条路，只是文件清单由这里给，
// 免得 shell 展开 glob 时把「一个文件都没匹配到」变成一条难懂的错误。
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { stdio: "inherit" },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(2);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
