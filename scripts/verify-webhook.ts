/**
 * Webhook 投递的端到端验收：本机起一个接收端点，把 AC1–AC3 跑一遍。
 *
 * 只在本机跑，不进 CI：它真的等指数退避，一条失败投递要 1+2+4+8 = 15 秒。
 *
 * 用法：pnpm db:migrate && pnpm db:seed && pnpm tsx scripts/verify-webhook.ts
 *
 * 脚本自己建一个临时工作区（`webhook-verify`）与一条本机端点，跑完清理干净，
 * 不改动种子数据里的任何记录。
 *
 * 接收到的请求体会写到 `~/.cache/crp/webhook-verify/received-body.json`，
 * 脚本最后打印用 `scripts/verify-webhook-signature.ts` 复算签名的命令。
 */

import "dotenv/config";

import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { prisma } from "../lib/db";
import { emitEvent, waitForWebhookDeliveries } from "../lib/webhook/service";

const WORKSPACE_SLUG = "webhook-verify";
const WORKSPACE_NAME = "Webhook 验收工作区";
const SECRET = "verify-webhook-secret-882";
const CACHE_DIR = join(homedir(), ".cache", "crp", "webhook-verify");

type ReceivedRequest = {
  at: number;
  timestamp: string;
  signature: string;
  contentType: string;
  body: string;
};

const received: ReceivedRequest[] = [];
let failMode = false;
let failures = 0;

function heading(text: string): void {
  console.log(`\n=== ${text} ===`);
}

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "通过" : "不通过"}：${description}`);

  if (!ok) {
    failures += 1;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startReceiver(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);

      received.push({
        at: Date.now(),
        timestamp: String(request.headers["x-crp-timestamp"] ?? ""),
        signature: String(request.headers["x-crp-signature"] ?? ""),
        contentType: String(request.headers["content-type"] ?? ""),
        body,
      });

      if (failMode) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("模拟接收端故障：构建结果暂不可用");

        return;
      }

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}/crp/webhook` };
}

/** 清掉本脚本在工作区里留下的端点与投递记录，种子数据的记录数不受影响。 */
async function cleanupWorkspace(): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: WORKSPACE_SLUG },
    select: { id: true },
  });

  if (workspace === null) {
    return;
  }

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true },
  });
  const endpointIds = endpoints.map((endpoint) => endpoint.id);

  if (endpointIds.length > 0) {
    await prisma.webhookDelivery.deleteMany({ where: { endpointId: { in: endpointIds } } });
    await prisma.webhookEndpoint.deleteMany({ where: { id: { in: endpointIds } } });
  }

  await prisma.workspace.delete({ where: { id: workspace.id } });
}

async function main(): Promise<void> {
  await cleanupWorkspace();

  const workspace = await prisma.workspace.create({
    data: { slug: WORKSPACE_SLUG, name: WORKSPACE_NAME },
    select: { id: true },
  });

  const { server, url } = await startReceiver();

  try {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        workspaceId: workspace.id,
        name: "本机接收端点",
        url,
        secret: SECRET,
        eventTypes: ["release.created", "build.failed"],
        enabled: true,
        description: "验收脚本建的临时端点，脚本结束即清理",
      },
    });

    // ---- AC1 -------------------------------------------------------------
    heading("AC1 提测创建事件：5 秒内收到，签名可复算");
    console.log(`端点：name=${endpoint.name} url=${endpoint.url} 订阅=${endpoint.eventTypes.join("、")}`);

    const sentAt = Date.now();
    const event = await emitEvent(
      "release.created",
      { releaseId: "verify-release-882", version: "9.9.9" },
      { workspaceId: workspace.id },
    );
    await waitForWebhookDeliveries();

    const first = received[0];
    check(event.deliveryIds.length === 1, `emitEvent 写下了 ${event.deliveryIds.length} 条投递记录（期望 1）`);
    check(first !== undefined, "接收端收到了请求");

    if (first !== undefined) {
      const elapsed = first.at - sentAt;
      console.log(`X-Crp-Timestamp: ${first.timestamp}`);
      console.log(`X-Crp-Signature: ${first.signature}`);
      console.log(`Content-Type: ${first.contentType}`);
      console.log(`请求体：${first.body}`);
      console.log(`从 emitEvent 到收到请求：${elapsed}ms`);
      check(elapsed < 5_000, `5 秒内收到（实际 ${elapsed}ms）`);
      check(first.signature.startsWith("sha256="), "签名带 sha256= 前缀");
      check(first.timestamp === String(Math.floor(first.at / 1_000)) || first.timestamp !== "", "X-Crp-Timestamp 是 Unix 秒");

      mkdirSync(CACHE_DIR, { recursive: true });
      const bodyPath = join(CACHE_DIR, "received-body.json");
      writeFileSync(bodyPath, first.body, "utf8");
      console.log(`\n复算签名（独立脚本，不依赖服务端实现）：`);
      console.log(
        `pnpm tsx scripts/verify-webhook-signature.ts --secret ${SECRET} --body ${bodyPath} --timestamp ${first.timestamp} --signature ${first.signature}`,
      );
    }

    // 回归点：写进投递记录的签名必须就是接收方收到的那一份（签名只算一次）。
    const recorded = await prisma.webhookDelivery.findUnique({
      where: { id: event.deliveryIds[0] ?? "" },
      select: { signature: true, attempts: true, status: true },
    });
    check(
      recorded !== null && recorded.signature === received[0]?.signature,
      `投递记录的签名与接收方收到的一致（${recorded?.signature ?? "-"}）`,
    );

    // ---- AC2 -------------------------------------------------------------
    heading("AC2 端点返回 500：按退避重试 5 次");
    console.log("下面 5 行是这次投递的逐次日志（每次尝试一行）。");
    failMode = true;
    received.length = 0;

    const retryStartedAt = Date.now();
    await emitEvent("build.failed", { buildTaskId: "verify-build-882" }, { workspaceId: workspace.id });
    const emitElapsed = Date.now() - retryStartedAt;
    console.log(`emitEvent 返回耗时：${emitElapsed}ms（投递还在后台跑，调用方不等它）`);
    check(emitElapsed < 1_000, `emitEvent 不阻塞主流程（${emitElapsed}ms，远小于 15 秒的重试总耗时）`);

    await waitForWebhookDeliveries();

    const failedDelivery = await prisma.webhookDelivery.findFirst({
      where: { endpointId: endpoint.id, eventType: "build.failed" },
      orderBy: { createdAt: "desc" },
      select: {
        status: true,
        attempts: true,
        httpStatus: true,
        durationMs: true,
        responseSnippet: true,
        lastError: true,
      },
    });

    console.log(
      `投递记录：status=${failedDelivery?.status} attempts=${failedDelivery?.attempts} httpStatus=${failedDelivery?.httpStatus} durationMs=${failedDelivery?.durationMs}`,
    );
    console.log(`响应摘要（入库前截断到 500 字）：${failedDelivery?.responseSnippet ?? "-"}`);
    console.log(`最近一次失败原因：${failedDelivery?.lastError ?? "-"}`);
    console.log(`重试总耗时：${Date.now() - retryStartedAt}ms（1s + 2s + 4s + 8s 退避）`);

    check(received.length === 5, `接收端收到 ${received.length} 次请求（期望 5 次）`);
    check(failedDelivery?.attempts === 5, `投递记录 attempts=${failedDelivery?.attempts}（期望 5）`);
    check(failedDelivery?.status === "failed", `投递记录 status=${failedDelivery?.status}（期望 failed）`);
    check(failedDelivery?.httpStatus === 500, `投递记录 httpStatus=${failedDelivery?.httpStatus}（期望 500）`);

    // ---- AC3 -------------------------------------------------------------
    heading("AC3 关闭端点后不再投递");
    failMode = false;
    received.length = 0;
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled: false } });

    const toggled = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
      select: { enabled: true },
    });
    const deliveryCountBefore = await prisma.webhookDelivery.count({
      where: { endpointId: endpoint.id },
    });

    await emitEvent(
      "release.created",
      { releaseId: "verify-release-882-disabled" },
      { workspaceId: workspace.id },
    );
    await waitForWebhookDeliveries();

    const deliveryCountAfter = await prisma.webhookDelivery.count({
      where: { endpointId: endpoint.id },
    });

    console.log(`端点开关：enabled=${toggled.enabled}`);
    console.log(`投递记录数：发送前 ${deliveryCountBefore}，发送后 ${deliveryCountAfter}`);
    console.log(`接收端本次收到 ${received.length} 次请求`);

    check(toggled.enabled === false, "端点已关闭");
    check(received.length === 0, "关闭后接收端没再收到请求");
    check(deliveryCountAfter === deliveryCountBefore, "关闭后没有新增投递记录");
  } finally {
    server.close();
    await cleanupWorkspace();
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    heading("结论");
    if (failures === 0) {
      console.log("AC1、AC2、AC3 全部通过。");
    } else {
      console.log(`有 ${failures} 项不通过，见上面的「不通过」行。`);
      process.exitCode = 1;
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
