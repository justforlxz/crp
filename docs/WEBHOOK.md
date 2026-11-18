# Webhook 通知

把提测与构建事件推给外部系统的约定。代码在 `lib/webhook/`，端点与投递日志在 `/webhooks` 页面管理。

## 事件清单

清单定义在 `lib/webhook/events.ts`，固定这五项，页面上的订阅选项、端点保存时的校验、投递正文里的 `type` 字段都从那里取：

| 事件类型 | 名称 | 什么时候发 | `data` 里通常带的字段 |
| --- | --- | --- | --- |
| `release.created` | 提测创建 | 提测记录建好、快照固化之后 | `releaseId`、`projectId`、`version`、`revision` |
| `build.started` | 构建开始 | 构建任务开始编译 | `releaseId`、`buildTaskId` |
| `build.succeeded` | 构建完成 | 构建任务成功 | `releaseId`、`buildTaskId` |
| `build.failed` | 构建失败 | 构建任务失败 | `releaseId`、`buildTaskId`、`reason` |
| `release.status_synced` | 提测状态同步 | 从 CRP 同步到新的提测状态 | `releaseId`、`status`、`crpWorkProgress` |

调用方式（A11–A14 用这一个入口，不要各自发 HTTP）：

```ts
import { emitEvent } from "@/lib/webhook";

await emitEvent("release.created", { releaseId, projectId, version, revision });
```

`emitEvent` 只等「投递记录写完」就返回，不等外部响应；投递失败不抛给调用方，也不改提测状态。还可以传 `{ workspaceId }` 只投该工作区的端点。

## 请求格式

POST，`Content-Type: application/json; charset=utf-8`。

| 请求头 | 内容 |
| --- | --- |
| `X-Crp-Timestamp` | Unix 秒，本次投递的签名时间 |
| `X-Crp-Signature` | `sha256=<十六进制摘要>`，算法见下 |

正文字段固定：

```json
{
  "id": "本次事件的标识；同一事件投给多个端点、重试多次都用这个值",
  "type": "release.created",
  "createdAt": "2026-11-18T19:31:49.455Z",
  "data": { "releaseId": "verify-release-882", "version": "9.9.9" }
}
```

同一次投递的多次重试**沿用同一份正文与同一组签名头**，接收方按 `id` 或签名去重即可。

## 签名算法

```
待签字符串 = `${X-Crp-Timestamp}.${请求体原文}`
X-Crp-Signature = "sha256=" + hex(HMAC-SHA256(key = 端点密钥, 待签字符串))
```

接收方自己按这三步实现一遍即可，Node 示例：

```js
import { createHmac } from "node:crypto";

const expected =
  "sha256=" +
  createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
```

请求体必须是**收到的原始字节**。先 `JSON.parse` 再 `JSON.stringify` 会改变键顺序与空白，算出来就不一致。

## 复算验收

`scripts/verify-webhook-signature.ts` 独立实现上面的算法，不引用 `lib/webhook` 的任何代码：

```bash
pnpm tsx scripts/verify-webhook-signature.ts \
  --secret <端点密钥> \
  --body ./received-body.json \
  --timestamp 1795031722 \
  --signature sha256=685f58d36b2ddf3bb79f42201dc01b9b83c5007ecd367235ecfa2900bed59607
```

输出（实测）：

```
算法：HMAC-SHA256(key = 端点密钥, message = `${X-Crp-Timestamp}.${请求体原文}`)，输出十六进制并加前缀 sha256=
时间戳（X-Crp-Timestamp）：1795031722
请求体字节数：169
复算出的签名：sha256=685f58d36b2ddf3bb79f42201dc01b9b83c5007ecd367235ecfa2900bed59607
接收到的签名：sha256=685f58d36b2ddf3bb79f42201dc01b9b83c5007ecd367235ecfa2900bed59607
结果：一致，签名可复算。
```

退出码：0 一致，1 不一致，2 参数不完整。密钥也可以放在环境变量 `WEBHOOK_SECRET` 里；`--body -` 表示从标准输入读。

## 重试

网络错误或非 2xx 都算失败，按指数退避重试，最多 5 次：

| 第几次失败之后 | 等待 |
| --- | --- |
| 1 | 1 秒 |
| 2 | 2 秒 |
| 3 | 4 秒 |
| 4 | 8 秒 |

5 次都失败就不再重试，投递记录置 `failed`。单次请求 10 秒超时。

## 投递日志

一次投递在 `webhook_delivery` 里是**一行**：`attempts` 记已尝试次数，`http_status`、`duration_ms`、`response_snippet`、`last_error` 都是最近一次尝试的结果。5 次尝试的逐次过程写在进程日志里，每行长这样：

```
[webhook] 投递失败 endpoint=本机接收端点 event=build.failed 第 2/5 次 http=500 耗时 4ms 原因=HTTP 500，2000ms 后重试
```

`/webhooks` 页面的「投递日志」按时间倒序列出：时间、端点、事件、关联记录、状态、HTTP 状态、耗时、尝试次数、响应摘要。关联记录取自正文 `data` 里的 `buildTaskId` 或 `releaseId`。

响应体入库前截断到 500 字。

## 端点与密钥

- 端点字段：名称、回调地址、订阅事件、启用开关、签名密钥；`(工作区, 回调地址)` 唯一。
- 签名密钥由使用者在页面上自己填写；保存后页面与日志都不回显，只列「已设置」。要更换就直接填新的。
- 停用的端点不再收到任何投递，历史投递记录保留。
- 同一次投递只算一次签名：`webhook_delivery.signature` 与接收方收到的 `X-Crp-Signature` 必然是同一份，重试也不会换时间戳。

## 已知限制

- 投递在进程内异步执行：进程在投递完成前退出时，那条记录会停在 `pending`，不会自动重投、也不会被标成失败。本版明确不做消息队列，需要时按记录人工重投。
- 响应体是整段读进内存后再截断入库（截断只限制了入库长度），端点返回超大响应时会占用相应内存；单次请求有 10 秒超时兜底。

## 端到端验收脚本

`scripts/verify-webhook.ts` 在本机起一个接收端点，把「收到请求且签名可复算」「端点返回 500 时重试 5 次」「关闭端点后不再投递」走一遍。它自己建一个临时工作区（`webhook-verify`），跑完清理干净，不改种子数据：

```bash
pnpm db:migrate && pnpm db:seed && pnpm tsx scripts/verify-webhook.ts
```

它会真的等退避间隔，一条失败投递约 15 秒，所以不进 CI。
