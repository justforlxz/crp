/**
 * CRP 接入的真实连通验证脚本。
 *
 * 跑一遍完整往返：登录 → 取交付分支 → 建临时 Topic → 查工作流 → 投递一个软件包 →
 * 查回 Release 与构建状态 → 删 Release → 放弃 Topic → 用错 token 换一条认证错误。
 *
 * 用法（凭据只从环境变量来，不要写进仓库）：
 *
 *   CRP_USERNAME=... CRP_PASSWORD=... \
 *   CRP_VERIFY_PROJECT=dde-file-manager \
 *   CRP_VERIFY_PROJECT_BRANCH=develop/eagle \
 *   CRP_VERIFY_COMMIT=f8e9527a37495a1f0f0d297f0ecedcbeaffab268 \
 *   pnpm tsx scripts/verify-crp.ts
 *
 * 可选环境变量：`CRP_VERIFY_BRANCH`（交付分支名，默认 eagle-1071）、
 * `CRP_VERIFY_TAG`（提测版本号，默认 9.9.9）。
 *
 * 环境变量既可以 `export` 到 shell，也可以按 `.env.example` 的说明写进 `.env`
 * （脚本入口加载 `.env`，与 `prisma/seed.ts` 的做法一致）。
 *
 * 清理边界：只删本脚本自己建的 Topic 里的 Release，不碰任何别人的 Topic。
 * CRP 没有删除 Topic 的接口（见 lib/integrations/crp/FINDINGS.md），
 * 所以最后一步是「放弃」而不是「删除」。
 */

import "dotenv/config";

import { createCrpClient } from "../lib/integrations/crp/client";
import { readCrpConfig } from "../lib/integrations/crp/config";
import { CrpAuthError, CrpError } from "../lib/integrations/crp/errors";

const DEFAULT_BRANCH = "eagle-1071";
const DEFAULT_TAG = "9.9.9";
const TOPIC_NAME_PREFIX = "a2-verify-";
/** 等构建状态变化的总时长上限，毫秒。 */
const BUILD_POLL_TIMEOUT_MS = 30_000;
const BUILD_POLL_INTERVAL_MS = 3_000;

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 缺参数时把缺的变量名一次列清楚，而不是跑一半才失败。 */
function readVerifyParams(source: Record<string, string | undefined>) {
  const project = source.CRP_VERIFY_PROJECT?.trim();
  const projectBranch = source.CRP_VERIFY_PROJECT_BRANCH?.trim();
  const commit = source.CRP_VERIFY_COMMIT?.trim();
  const missing = [
    project ? null : "CRP_VERIFY_PROJECT",
    projectBranch ? null : "CRP_VERIFY_PROJECT_BRANCH",
    commit ? null : "CRP_VERIFY_COMMIT",
  ].filter((name): name is string => name !== null);

  if (!project || !projectBranch || !commit) {
    throw new Error(
      `验证脚本缺少环境变量：${missing.join("、")}。` +
        "它们是「投递哪个软件包、哪个分支、哪个提交」，没有默认值——随便猜一个会把构建打到错误的提交上。",
    );
  }

  return {
    branchName: source.CRP_VERIFY_BRANCH?.trim() || DEFAULT_BRANCH,
    project,
    projectBranch,
    commit,
    tag: source.CRP_VERIFY_TAG?.trim() || DEFAULT_TAG,
  };
}

async function waitForBuildState(
  listReleases: () => Promise<Array<{ releaseId: number; buildState: string }>>,
): Promise<string> {
  const deadline = Date.now() + BUILD_POLL_TIMEOUT_MS;
  let last = "";

  while (Date.now() < deadline) {
    const releases = await listReleases();
    const state = releases[0]?.buildState ?? "MISSING";
    if (state !== last) {
      console.log(`  构建状态：${state}`);
      last = state;
    }

    // APPLYING 表示还在排队/上传；出现别的值说明这一轮已经结束。
    if (state !== "APPLYING") {
      return state;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, BUILD_POLL_INTERVAL_MS);
    });
  }

  return last;
}

async function main(): Promise<void> {
  const config = readCrpConfig();
  const params = readVerifyParams(process.env);
  const client = createCrpClient({ ...config, tokenPath: config.tokenPath });

  step("1. 登录");
  const token = await client.login();
  const user = await client.getCurrentUser();
  console.log(`  账号：${user.name}（${user.nameCn}）`);
  console.log(`  token 长度：${token.length}（不打印内容）`);
  console.log(`  token 缓存：${config.tokenPath}`);

  step("2. 取交付分支");
  const branches = await client.listBranches();
  const branch = branches.find((item) => item.name === params.branchName);
  if (!branch) {
    throw new Error(`CRP 交付分支列表里没有 ${params.branchName}，共取到 ${branches.length} 条`);
  }
  console.log(`  共 ${branches.length} 条交付分支；${branch.name} = ID ${branch.id}`);

  step("3. 建临时 Topic");
  const topicName = `${TOPIC_NAME_PREFIX}${Date.now()}`;
  const topic = await client.createTopic({ name: topicName, branchId: branch.id, owner: user.name });
  console.log(`  Topic ID：${topic.topicId}`);
  console.log(`  Topic 名称：${topic.name}`);
  console.log(`  Owner：${topic.owner}`);

  step("4. 查工作流进度（getTopicWorkflow）");
  const before = await client.getTopicWorkflow(topic.topicId);
  console.log(`  WorkProgress = ${before.workProgress}（${before.workProgressLabel}）`);
  console.log(`  已转测？${before.workProgress >= 20 ? "是" : "否（还能改包）"}`);

  let releaseId: number | null = null;
  try {
    step("5. 投递软件包（ChangeLogMode=false，Tag 用调用方给的版本号）");
    const submitted = await client.submitRelease({
      topicId: topic.topicId,
      projectName: params.project,
      branch: params.projectBranch,
      commit: params.commit,
      branchId: branch.id,
      tag: params.tag,
    });
    releaseId = submitted.releaseId;
    console.log(`  Release ID：${submitted.releaseId}`);
    console.log(`  ProjectID：${submitted.projectId}`);
    console.log(`  请求里的 Tag：${submitted.tag}，ChangeLogMode：${submitted.changeLogMode}`);

    step("6. 查回 Release");
    const releases = await client.listReleases(topic.topicId);
    for (const item of releases) {
      console.log(
        `  Release ${item.releaseId}：${item.projectName} ${item.branch} ` +
          `Tag=${item.tag} buildId=${item.buildId} 状态=${item.buildState}`,
      );
    }

    step("7. 等构建状态变化（最多 30 秒）");
    const finalState = await waitForBuildState(() => client.listReleases(topic.topicId));
    console.log(`  最终状态：${finalState}`);

    step("8. 查 Topic 仓库地址（topicUrls）");
    const urls = await client.topicUrls({ branchId: branch.id, topicId: topic.topicId });
    console.log(`  仓库地址：${urls.repoUrls.length === 0 ? "（构建尚未产出，空）" : urls.repoUrls.join(", ")}`);
  } finally {
    step("9. 清理：删除本脚本投递的 Release");
    const remaining = await client.listReleases(topic.topicId);
    const own = remaining.filter((item) => releaseId === null || item.releaseId === releaseId);
    for (const item of own) {
      await client.deleteRelease(item.releaseId);
      console.log(`  已删除 Release ${item.releaseId}`);
    }
    const afterDelete = await client.listReleases(topic.topicId);
    console.log(`  删除后该 Topic 的 Release 数量：${afterDelete.length}`);

    step("10. 清理：放弃临时 Topic（CRP 无删除 Topic 的接口）");
    await client.abandonTopic(topic.topicId);
    console.log(`  已放弃 Topic ${topic.topicId}（${topic.name}）`);
  }

  step("11. 认证错误验证（故意用错 token）");
  const badClient = createCrpClient({
    baseUrl: config.baseUrl,
    token: "deliberately-wrong-token",
    tokenPath: null,
    retries: 0,
  });
  try {
    await badClient.getCurrentUser();
    throw new Error("预期应该抛出认证错误，但请求成功了");
  } catch (error) {
    if (!(error instanceof CrpAuthError)) {
      throw error;
    }
    console.log(`  错误类型：${error.name}（kind=${error.kind}，status=${error.status}）`);
    console.log(`  错误信息：${error.message}`);
    console.log(`  响应片段：${error.responseSnippet}`);
  }

  step("验证完成");
  console.log("  登录、取基线、建 Topic、投递 Release、查 Release、查工作流、清理，全部走通。");
}

main().catch((error: unknown) => {
  if (error instanceof CrpError) {
    console.error(`\n[失败] ${error.name}：${error.message}`);
    if (error.responseSnippet) {
      console.error(`CRP 响应片段：${error.responseSnippet}`);
    }
  } else {
    console.error(`\n[失败] ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exitCode = 1;
});
