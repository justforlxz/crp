/**
 * 「软件包 → CRP 项目」映射的真实连通验证（A16 缺陷修复的 AC3）。
 *
 * 只做一件事：对每个待验证的软件包，用**仓库里的真实代码**算出它该在 CRP 里叫什么名字
 * （`resolveCrpProjectName`），再走真实的 `resolveProjectId` 查出 `ProjectID`，把结果打出来。
 *
 * 全程只读：不建 Topic、不投 Release、不删任何东西。CRP 侧只发了 `POST /project`（查询）。
 *
 * 用法（凭据只从环境变量来，不要写进仓库）：
 *
 *   CRP_VERIFY_BRANCH_ID=108 \
 *   CRP_VERIFY_PACKAGES=kwin,wayland \
 *   pnpm tsx scripts/verify-crp-project.ts
 *
 * 环境变量：
 *
 * | 变量 | 默认 | 含义 |
 * | --- | --- | --- |
 * | `--user <邮箱>` / `CREDENTIAL_USER_EMAIL` | 无 | 用谁的凭据；给了就登录后查询，没给按匿名查询（见下） |
 * | `CRP_VERIFY_BRANCH_ID` | `108` | CRP 交付分支 ID（`eagle-1071` 是 108） |
 * | `CRP_VERIFY_PACKAGES` | `kwin` | 逗号分隔的**本地包名**；这些包必须已经登记在库里 |
 *
 * 关于凭据：本脚本只调 `POST /project` 查项目，实测（2026-11-19，`https://crp.uniontech.com/api`）
 * 这个接口匿名可用，带上一个随便的 `Authorization` 头也照样返回结果。所以没配凭据时不登录、
 * 拿一个占位 token 发请求 —— 只读查询，不冒充任何身份写东西。要投 Release 的脚本仍必须登录。
 *
 * 包名与 CRP 项目名的对应关系取自数据库里登记的 `package` 行，不在这条命令里再写一遍：
 * 这条脚本要证明的正是「登记的那一列会被投递层用上」。
 *
 * 退出码：全部解析成功为 0；任何一个包失败（没登记、解析不出来、CRP 里没有同名项目）为 1。
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import { CRP_DEFAULT_BASE_URL, readCrpConfig } from "../lib/integrations/crp/config";
import { findScriptUserId, readScriptUserEmail } from "./credentialUser";
import { resolveProjectId } from "../lib/integrations/crp/projects";
import { createCrpTransport } from "../lib/integrations/crp/request";
import { resolveCrpProjectName } from "../lib/packages/crpProject";

const DEFAULT_BRANCH_ID = 108;

function readParams(source: Record<string, string | undefined>) {
  const branchId = Number(source.CRP_VERIFY_BRANCH_ID?.trim() || DEFAULT_BRANCH_ID);
  const packageNames = (source.CRP_VERIFY_PACKAGES ?? "kwin")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new Error(`CRP_VERIFY_BRANCH_ID 不是合法的分支 ID：${String(branchId)}`);
  }

  if (packageNames.length === 0) {
    throw new Error("CRP_VERIFY_PACKAGES 为空：至少给一个已登记的包名。");
  }

  return { branchId, packageNames };
}

/** 没配 CRP 凭据时的查询方式：不登录，只发只读查询（`POST /project` 实测匿名可用）。 */
function anonymousTransport(source: Record<string, string | undefined>) {
  const baseUrl = (source.CRP_BASE_URL?.trim() || CRP_DEFAULT_BASE_URL).replace(/\/+$/, "");

  return { baseUrl, transport: createCrpTransport({ baseUrl, token: "anonymous" }) };
}

async function main(): Promise<void> {
  const params = readParams(process.env);

  let baseUrl: string;
  let transport: ReturnType<typeof createCrpTransport>;
  let loggedIn = false;

  const email = readScriptUserEmail();

  if (email !== null) {
    // 指名了账号就一定用它：这个账号没配凭据时直接报错（`CredentialMissingError`），
    // 不悄悄退回匿名 —— 那样会让人以为「登录过了」。
    const config = await readCrpConfig(await findScriptUserId(email));
    baseUrl = config.baseUrl;
    transport = createCrpTransport(config);
    loggedIn = true;
  } else {
    const anonymous = anonymousTransport(process.env);
    baseUrl = anonymous.baseUrl;
    transport = anonymous.transport;
  }

  console.log(`CRP 接口：${baseUrl}`);
  console.log(`查询方式：${loggedIn ? "登录后的只读查询" : "匿名只读查询（没指定 --user）"}`);
  console.log(`交付分支：ID ${params.branchId}`);
  console.log(`待验证的包：${params.packageNames.join("、")}`);

  let failed = 0;

  for (const packageName of params.packageNames) {
    const pkg = await prisma.package.findUnique({
      where: { name: packageName },
      select: { name: true, crpProjectName: true, repoPath: true },
    });

    if (pkg === null) {
      failed += 1;
      console.log(`❌ ${packageName}｜未登记：先在软件包管理里登记这个包（含 CRP 项目名）再验证。`);
      continue;
    }

    let crpProjectName: string;

    try {
      crpProjectName = resolveCrpProjectName(pkg);
    } catch (error) {
      failed += 1;
      console.log(`❌ ${packageName}｜登记的 CRP 项目名解析失败：${(error as Error).message}`);
      continue;
    }

    try {
      const projectId = await resolveProjectId(transport, crpProjectName, params.branchId);
      console.log(
        `✅ ${packageName}｜仓库 ${pkg.repoPath}｜CRP 项目名 ${crpProjectName}｜ProjectID ${projectId}`,
      );
    } catch (error) {
      failed += 1;
      console.log(
        `❌ ${packageName}｜CRP 项目名 ${crpProjectName}｜解析 ProjectID 失败：${(error as Error).message}`,
      );
    }
  }

  await prisma.$disconnect();

  if (failed > 0) {
    console.log(`\n共 ${params.packageNames.length} 个包，${failed} 个失败。`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n共 ${params.packageNames.length} 个包，全部解析成功。`);
}

main().catch((error: unknown) => {
  console.error("验证脚本执行失败：", error);
  process.exitCode = 1;
});
