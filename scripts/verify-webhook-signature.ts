/**
 * 独立复算 Webhook 投递签名。
 *
 * 这个脚本刻意不引用 `lib/webhook` 里的任何实现：算法只按 `docs/WEBHOOK.md` 公开的
 * 三步复写一遍，用来证明「外部按同一套算法就能算出同样的签名」。
 *
 *   待签字符串 = `${X-Crp-Timestamp}.${请求体原文}`
 *   签名       = "sha256=" + hex(HMAC-SHA256(key = 端点密钥, 待签字符串))
 *
 * 用法：
 *
 *   pnpm tsx scripts/verify-webhook-signature.ts \
 *     --secret <端点密钥> \
 *     --body ./received-body.json \
 *     --timestamp 1763496000 \
 *     --signature sha256=<接收到的签名>
 *
 * 参数：
 *   --secret     端点密钥；也可以放在环境变量 WEBHOOK_SECRET 里
 *   --body       接收到的原始请求体文件；给 `-` 表示从 stdin 读
 *   --timestamp  接收到的 X-Crp-Timestamp 头
 *   --signature  接收到的 X-Crp-Signature 头；不传就只打印算出来的签名
 *
 * 退出码：0 一致（或未给 --signature），1 不一致，2 参数不完整。
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

type Options = {
  secret: string;
  body: string;
  timestamp: string;
  signature: string | null;
};

function readOptions(argv: readonly string[]): Options | string {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      return `参数 --${key} 缺少取值。`;
    }

    values.set(key, value);
    index += 1;
  }

  const secret = values.get("secret") ?? process.env["WEBHOOK_SECRET"] ?? "";
  const bodyPath = values.get("body") ?? "";
  const timestamp = values.get("timestamp") ?? "";

  if (secret === "") {
    return "缺少端点密钥：用 --secret 传入，或设置环境变量 WEBHOOK_SECRET。";
  }

  if (bodyPath === "") {
    return "缺少请求体：用 --body 指定接收到的原始请求体文件（`-` 表示 stdin）。";
  }

  if (timestamp === "") {
    return "缺少 X-Crp-Timestamp：用 --timestamp 传入接收到的头值。";
  }

  let body: string;
  try {
    body = readFileSync(bodyPath === "-" ? 0 : bodyPath, "utf8");
  } catch (error) {
    return `读不到请求体 ${bodyPath}：${error instanceof Error ? error.message : String(error)}`;
  }

  return { secret, body, timestamp, signature: values.get("signature") ?? null };
}

/** 文档里公开的算法，此处独立实现一遍。 */
function computeSignature(secret: string, timestamp: string, body: string): string {
  const message = `${timestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  return `sha256=${digest}`;
}

function main(): number {
  const options = readOptions(process.argv.slice(2));

  if (typeof options === "string") {
    console.error(options);
    console.error(
      "\n用法：pnpm tsx scripts/verify-webhook-signature.ts --secret <密钥> --body <请求体文件> --timestamp <X-Crp-Timestamp> [--signature <X-Crp-Signature>]",
    );

    return 2;
  }

  const computed = computeSignature(options.secret, options.timestamp, options.body);

  console.log("算法：HMAC-SHA256(key = 端点密钥, message = `${X-Crp-Timestamp}.${请求体原文}`)，输出十六进制并加前缀 sha256=");
  console.log(`时间戳（X-Crp-Timestamp）：${options.timestamp}`);
  console.log(`请求体字节数：${Buffer.byteLength(options.body, "utf8")}`);
  console.log(`复算出的签名：${computed}`);

  if (options.signature === null) {
    console.log("未提供 --signature，只打印复算结果。");

    return 0;
  }

  const matched = computed === options.signature;
  console.log(`接收到的签名：${options.signature}`);
  console.log(matched ? "结果：一致，签名可复算。" : "结果：不一致。");

  return matched ? 0 : 1;
}

process.exitCode = main();
