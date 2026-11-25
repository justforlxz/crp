/**
 * 功能组：提测进入队列（FUNC-25）与 Webhook 签名（FUNC-33）。
 *
 * 需要真跑 CRP 才看得出的几条（依赖满足才投递、上游失败下游不动、限流等待、增量提测、
 * 从 CRP 导入、两个取消入口）在当前环境里没有沙箱，统一留 TODO 并写清卡在哪；
 * 它们对应的实现分支在同名单测里已经用假 CRP 覆盖过（见各条 TODO 的原因）。
 */

import "dotenv/config";

import { after, before } from "node:test";

import { acceptanceTodo, acceptanceWithEnv } from "../support/case";
import { disconnect } from "../support/db";
import { hasEnv } from "../support/env";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectEqual, expectTrue } from "../support/report";

const PREFIX = "zzac25";
const PACKAGE = `${PREFIX}-kwin`;
const SHA = "4".repeat(40);

let fixture: Fixture | null = null;
let projectId = "";

before(async () => {
  if (!hasEnv("database")) {
    return;
  }

  fixture = await createFixture(PREFIX);
  projectId = await fixture.project({ key: `${PREFIX}-p`, name: `${PREFIX} 项目` });
  const pkg = await fixture.package({ name: PACKAGE });
  await fixture.addSoftware(projectId, pkg);
});

after(async () => {
  await fixture?.cleanup();
  await disconnect();
});

acceptanceWithEnv("FUNC-25", FIXTURE_ENV, async () => {
  const { createRelease, loadReleaseList, releaseStatusLabel } = await import("../../../lib/releases");

  const created = await createRelease(
    {
      projectId,
      version: `${PREFIX}-queue.0`,
      description: null,
      packages: [
        { packageName: PACKAGE, branch: "develop/eagle", commitSha: SHA, customTag: null },
      ],
    },
    {
      createdById: fixture!.userId,
      reader: { readCodeVersion: () => Promise.resolve("5.0.0-1") },
    },
  );

  const list = await loadReleaseList({ workspaceId: fixture!.workspaceId, tab: "all" });

  expectEqual("FUNC-25", "提测记录首位的 ID", created.id, list.rows[0]?.id);
  expectEqual(
    "FUNC-25",
    "首位那条的状态",
    releaseStatusLabel("pending"),
    releaseStatusLabel(list.rows[0]?.status ?? ""),
  );
  expectEqual("FUNC-25", "首位那条的状态码", "pending", list.rows[0]?.status);
});

acceptanceTodo(
  "FUNC-26",
  "「上游成功才投递下游」要驱动 `advanceRelease` 走完整投递链路，需要 CRP / Shuttle 沙箱；本仓库 `tests/build-dispatch.test.ts` 用假 CRP 覆盖了三层链的投递顺序",
);

acceptanceTodo(
  "FUNC-27",
  "「上游失败下游不动」同样要完整投递与构建回写，需要 CRP / Shuttle 沙箱；`tests/build-dispatch.test.ts` 已用假 CRP 覆盖（下游保持等待、提测判 failed）",
);

acceptanceTodo(
  "FUNC-28",
  "「CRP 返回 429 时判等待限流、不判失败」要有能返回 429 的 CRP；`tests/build-dispatch.test.ts` 用 `CrpRateLimitedError` 覆盖了这条判定",
);

acceptanceTodo(
  "FUNC-29",
  "增量提测（第 2 轮 + 上一轮标记被取代）走 `applyReleaseUpdate`，它要真调 CRP 删旧 Release 再建新的；`tests/release-update.test.ts` 用假 CRP 覆盖",
);

acceptanceTodo(
  "FUNC-30",
  "「从 CRP 导入已有 Topic」要真读 CRP 的主题与 Release 列表；`tests/release-import.test.ts` 用假 CRP 覆盖",
);

acceptanceWithEnv("FUNC-33", FIXTURE_ENV, async () => {
  const { WEBHOOK_SIGNATURE_HEADER, computeWebhookSignature, verifyWebhookSignature } =
    await import("../../../lib/webhook");

  const secret = "acceptance-webhook-secret";
  const timestamp = "1795000000";
  const body = JSON.stringify({ event: "release.submitted", releaseId: `${PREFIX}-r` });

  const signature = computeWebhookSignature(secret, timestamp, body);

  expectEqual("FUNC-33", "签名请求头名字", "X-Crp-Signature", WEBHOOK_SIGNATURE_HEADER);
  expectTrue(
    "FUNC-33",
    "用端点密钥与原始 body 能验签通过",
    "verifyWebhookSignature 返回 true",
    verifyWebhookSignature({ secret, timestamp, body, signature }),
  );
  expectTrue(
    "FUNC-33",
    "body 被改过就验不过（证明签的是原始 body）",
    "verifyWebhookSignature 返回 false",
    !verifyWebhookSignature({ secret, timestamp, body: `${body} `, signature }),
  );
});
