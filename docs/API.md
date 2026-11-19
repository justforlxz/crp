# 接口文档

本文件只写外部系统会调用的接口。页面路由不在文档范围内。

## POST /api/packages

按名称登记或更新软件包。供外部系统（发布流水线、包管理脚本）直接提交，不需要登录平台。

### 鉴权

请求头带独立 token：

```
Authorization: Bearer <PACKAGE_API_TOKEN>
```

- token 取自服务端环境变量 `PACKAGE_API_TOKEN`，与用户会话无关；调用方有没有浏览器、登不登录都不影响。
- 服务端没配置这个变量时，接口一律返回 `401`，不会退化成「谁都能写」。
- token 只放在请求头里，不要写进查询串：查询串会被访问日志记下来。

### 请求体

可以是**一个对象**，也可以是**一个数组**（一次最多 200 条）。数组里任意一条不合法，整批拒绝，不会写入半批数据。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 源码包名。小写字母或数字开头，只允许小写字母、数字与 `+` `-` `.`，例如 `kwin`。全局唯一。 |
| `repoPath` | string | 是 | 仓库路径，形如 `deepin-kde/kwin`。不允许首尾斜杠与空段。全局唯一。 |
| `defaultBranch` | string | 是 | 默认跟踪分支，形如 `develop/eagle`。不能包含空白字符。 |
| `currentVersion` | string | 否 | 当前版本，例如 `5.27.10.2-1`。不能包含空白字符；不传或传空字符串即为空。 |

单条：

```json
{
  "name": "kwin",
  "repoPath": "deepin-kde/kwin",
  "defaultBranch": "develop/eagle",
  "currentVersion": "5.27.10.2-1"
}
```

数组：

```json
[
  { "name": "kwin", "repoPath": "deepin-kde/kwin", "defaultBranch": "develop/eagle" },
  { "name": "dde-dock", "repoPath": "deepin/dde-dock", "defaultBranch": "develop/eagle", "currentVersion": "5.11.9-1" }
]
```

### 幂等

以 `name` 为准：库里已有同名包就**更新**它的仓库路径、默认分支、当前版本，不会插出第二条记录。连续提交同一个名字多少次，`package` 表里始终只有一行。

`repoPath` 也唯一：如果这条仓库路径已经被**另一个** `name` 占用，整批返回 `409`。

改动了 `repoPath` 或 `defaultBranch` 时，原先同步到的「当前 Commit」与「最近同步时间」会被清空 —— 它们属于旧分支，留着会误导页面。

### 返回体

成功：

```json
{
  "created": ["dde-dock"],
  "updated": ["kwin"],
  "total": 2
}
```

| 字段 | 说明 |
| --- | --- |
| `created` | 本次新建的包名，按请求顺序 |
| `updated` | 本次按同名更新的包名，按请求顺序 |
| `total` | 本次处理的条数 |

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 全部是同名更新，没有新建 |
| `201` | — | 至少新建了一条 |
| `400` | `invalid_json` | 请求体不是合法 JSON |
| `400` | `invalid_payload` | 字段校验未通过，`details` 里逐条给出字段与原因 |
| `401` | `unauthorized` | 没有 token、token 不对，或服务端没配置 `PACKAGE_API_TOKEN` |
| `409` | `conflict` | 仓库路径已被另一个软件包占用 |
| `500` | `internal_error` | 数据库写入失败，详情看服务端日志 |

错误响应统一是这个形状：

```json
{
  "error": {
    "code": "invalid_payload",
    "message": "请求体校验未通过。",
    "details": [
      { "field": "items[1].name", "message": "name 不能为空。源码包名用小写字母、数字与 + - . 组成，例如 kwin。" }
    ]
  }
}
```

`details` 只在字段校验失败时出现；数组提交时字段名带下标。

### 示例

```bash
# 单条
curl -X POST http://localhost:3000/api/packages \
  -H "Authorization: Bearer $PACKAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"kwin","repoPath":"deepin-kde/kwin","defaultBranch":"develop/eagle","currentVersion":"5.27.10.2-1"}'

# 同一名称再提交一次，字段被更新，库里仍只有一条
curl -X POST http://localhost:3000/api/packages \
  -H "Authorization: Bearer $PACKAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"kwin","repoPath":"deepin-kde/kwin","defaultBranch":"develop/master","currentVersion":"5.27.11.0-1"}'

# 不带 token，返回 401
curl -i -X POST http://localhost:3000/api/packages \
  -H "Content-Type: application/json" \
  -d '{"name":"kwin","repoPath":"deepin-kde/kwin","defaultBranch":"develop/eagle"}'
```

## POST /api/jobs/baseline-sync

基线同步的定时入口。本仓库没有常驻调度进程，也没有队列或额外的调度服务：外部定时器
（cron 或 systemd timer）每小时 POST 一次这个地址即可。页面上的「立即同步」按钮调的是
同一段同步逻辑（`runBaselineSync()`），不是第二份实现。

### 鉴权

请求头带独立 token：

```
Authorization: Bearer <SYNC_JOB_TOKEN>
```

- token 取自服务端环境变量 `SYNC_JOB_TOKEN`，与用户会话、`PACKAGE_API_TOKEN` 都无关。
- 服务端没配置这个变量时接口一律返回 `401`，不会退化成「谁都能触发同步」。

### 请求体

无。定时入口固定按「定时触发」处理：刷新分支列表，并只刷新**被项目选中、且缓存已过期
（1 小时）**的基线的软件包版本。要强制全部重拉，用页面上的「立即同步」。

### 返回

`200`：本次同步的明细。

```json
{
  "trigger": "schedule",
  "list": { "status": "success", "itemCount": 108, "missingCount": 0, "errorMessage": null },
  "packages": [
    { "baselineId": "…", "name": "eagle-1071", "status": "success", "itemCount": 124, "errorMessage": null }
  ],
  "skippedPackageCount": 104,
  "requests": {
    "total": 9,
    "crp": 1,
    "shuttle": 8,
    "urls": ["crp https://crp.uniontech.com/api/branches", "shuttle …"]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `list` | 分支列表同步结果。`itemCount` 是 CRP `/branches` 返回的条数；`missingCount` 是本次新标记「已消失」的基线数 |
| `packages` | 本次实际刷新过的基线，一条一行；`itemCount` 是该基线缓存里的软件包数 |
| `skippedPackageCount` | 没参与刷新的基线数：没被项目选中、缓存还没过期，或已从 CRP 消失 |
| `requests` | 本次请求明细，用来核对「分支列表 1 次、每个参与刷新的基线 2 次、逐包请求 0 次」 |

`502`：分支列表同步失败（CRP 不通、返回格式不对等）。此时基线表一行未动，上一次成功的数据还在，
失败原因见 `list.errorMessage` 与页面上的同步记录。

`401`：没配置 token 或 token 不对。

### 示例

```bash
# 每小时跑一次（crontab 写法）
0 * * * * curl -fsS -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN" \
  http://localhost:3000/api/jobs/baseline-sync
```

## POST /api/releases

创建一次提测：落一条 `release` 与每个软件包一条 `release_package_snapshot`，
并把项目清单里每个软件包的 `last_submitted_commit` 更新为本次提交的 Commit。

页面 `/releases/new` 的三步向导提交到这里。阻断条件、软件包清单一致性、版本号唯一
全部在服务端判一次：只靠页面禁用按钮不算数，直接调接口同样会被拦住。

### 鉴权

用用户会话（httpOnly Cookie），工作区从项目归属查出，**不采信请求体里传来的工作区**：

- 未登录 → `401 unauthenticated`；
- 项目所在工作区里没有成员关系 → `404 workspace_not_found`（与「工作区不存在」同一个响应）；
- 是成员但低于「开发者」角色 → `403 forbidden`。

### 请求体

```json
{
  "projectId": "01a1ee26-82e3-7644-ab2e-a8c9c40fe147",
  "version": "25.0.2",
  "description": "V25 第二个提测",
  "packages": [
    {
      "packageName": "kwin",
      "branch": "develop/eagle",
      "commitSha": "4f0b1d2e8c9a7b6d5e4f3a2b1c0d9e8f7a6b5c4d",
      "customTag": "5.27.12.0"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 提测归属项目 |
| `version` | string | 是 | Topic 版本号，不能包含空白字符，最长 100 字符；同一项目内唯一 |
| `description` | string | 否 | 提测说明 |
| `packages` | array | 是 | 项目清单里的**全部**软件包，不多不少；顺序不参与判定 |
| `packages[].packageName` | string | 是 | 源码包名，例如 `kwin` |
| `packages[].branch` | string | 是 | 固化的分支，不能包含空白字符 |
| `packages[].commitSha` | string | 是 | 固化的 Commit，十六进制提交号（7 位以上）；分支名不算 |
| `packages[].customTag` | string \| null | 否 | 自定义 Tag。填了它，提测版本就是它本身；不填则等于代码版本 |

**代码版本由服务端现读**：每个包都按 `repoPath` 与 `commitSha` 去 Gerrit 读
`debian/changelog` 的首条版本，请求体里没有这个字段，也不能伪造。仓库版本取自基线缓存
（`baseline_package_version`），查不到就是空。

### 阻断条件

三条都在服务端判，任一成立整次提测不写库：

| 条件 | 状态码 | 提示 |
| --- | --- | --- |
| 项目没有软件清单 | `409` | 先去项目详情页把软件包加进来 |
| 依赖存在环 | `409` | 带出回路，例如 `kwin → dde-dock → kwin`，去软件包管理修正 |
| 基线未同步（已消失 / 同步失败 / 从未同步） | `409` | 基线拿不到仓库版本 |

「无变化」的软件包**不是**阻断条件：清单内全部软件都进快照。

### 返回体

`201`：创建成功。

```json
{
  "id": "01a1f0c0-…",
  "version": "25.0.2",
  "revision": 1,
  "packageCount": 6,
  "changedCount": 4,
  "summary": "本次将提测 6 个软件，其中 4 个有更新。",
  "order": ["deepin-polkit-agent", "dde-session-shell", "dde-dock", "kwin", "dde-file-manager", "dde-launchpad"],
  "snapshots": [
    {
      "packageName": "deepin-polkit-agent",
      "attempt": 1,
      "branch": "develop/eagle",
      "commitSha": "4f0b1d2e…",
      "codeVersion": "0.0.12-1",
      "repoVersion": "0.0.11-1",
      "releaseVersion": "0.0.12-1",
      "changed": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 提测记录 ID |
| `revision` | 提测轮次，本接口固定为 `1`（补包换包走 A17 的追加轮次） |
| `packageCount` | 本次写入的快照条数 |
| `changedCount` | 其中 Commit 与上次提测不同的条数 |
| `summary` | 页面直接显示的一句话 |
| `order` | 依赖拓扑排序结果（上游在前），也是快照的写入顺序 |
| `snapshots` | 每条快照的固化内容 |

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `201` | — | 创建成功 |
| `400` | `invalid_json` | 请求体不是合法 JSON |
| `400` | `invalid_payload` | 字段校验未通过，`details` 里逐条给出字段与原因 |
| `400` | `invalid_payload` | 提交的软件包与项目清单不一致（多包 / 少包 / 重复包） |
| `401` | `unauthenticated` | 未登录 |
| `403` | `forbidden` | 工作区角色低于「开发者」 |
| `404` | `project_not_found` | 项目不存在 |
| `404` | `workspace_not_found` | 账号不属于项目所在的工作区 |
| `409` | `conflict` | 阻断条件成立，或同一项目里已有同版本号的提测记录 |
| `502` | `invalid_payload` | 读 Gerrit 失败（凭据不对、仓库或提交不存在），消息里指出是哪个包 |
| `500` | `internal_error` | 数据库写入失败，详情看服务端日志 |

### 示例

```bash
# 不登录：401
curl -i -X POST http://localhost:3000/api/releases \
  -H "Content-Type: application/json" \
  -d '{"projectId":"…","version":"25.0.2","packages":[]}'

# 带会话 Cookie 提交
curl -X POST http://localhost:3000/api/releases \
  -H "Content-Type: application/json" \
  -H "Cookie: crp_session=$SESSION" \
  -d @release.json
```

## GET /api/releases/{id}/dispatch

看一条提测的投递详情：每个软件包投递时用的分支、Commit、提测版本，CRP 给回来的 Release ID 与
构建 ID，当前的构建状态，以及这条提测最近的 CRP 请求记录。

这是 A12 的验收入口：AC1 要的「请求时间线」就是 `crpCalls`，AC4 要的「每个包的投递参数与 CRP
Release ID」就是 `packages`。A13 的提测详情页合入后，这些字段直接搬过去，页面不用另写一套查询。

### 鉴权

用用户会话（httpOnly Cookie），要「只读」及以上角色。工作区从提测归属查出，不采信查询串。
提测不存在、或账号不在它所属的工作区，都返回 `404 release_not_found`。

### 返回体

`200`：

```json
{
  "releaseId": "01a1f0c0-…",
  "version": "25.0.2",
  "revision": 1,
  "status": "building",
  "projectId": "01a1ee26-…",
  "crpTopicId": "29158",
  "crpBranchId": "108",
  "finishedAt": null,
  "packages": [
    {
      "packageName": "kwin",
      "attempt": 1,
      "branch": "develop/eagle",
      "commitSha": "4f0b1d2e8c9a7b6d5e4f3a2b1c0d9e8f7a6b5c4d",
      "codeVersion": "5.27.12.0-1",
      "repoVersion": "5.27.11.0-1",
      "releaseVersion": "5.27.12.0",
      "snapshotStatus": "building",
      "crpReleaseId": "107449",
      "crpBuildId": "600208",
      "buildStatus": "building",
      "statusReason": null,
      "blockedByPackage": null,
      "jobs": [{ "arch": "amd64", "status": "building" }]
    },
    {
      "packageName": "dde-dock",
      "attempt": 1,
      "branch": "develop/eagle",
      "commitSha": "…",
      "codeVersion": "5.11.9-1",
      "repoVersion": null,
      "releaseVersion": "5.11.9-1",
      "snapshotStatus": "failed",
      "crpReleaseId": null,
      "crpBuildId": null,
      "buildStatus": "failed",
      "statusReason": "因上游 kwin 构建失败而阻断，本包没有投递",
      "blockedByPackage": "kwin",
      "jobs": []
    }
  ],
  "crpCalls": [
    {
      "id": "01a1f10a-…",
      "createdAt": "2026-11-19T02:10:31.442Z",
      "method": "POST",
      "url": "https://crp.uniontech.com/api/topics/29158/new_release",
      "statusCode": 201,
      "durationMs": 812,
      "responseSnippet": "107449",
      "packageName": "kwin"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `packages[].releaseVersion` | 本次投给 CRP 的版本（CRP 的 Tag），取自快照 |
| `packages[].crpReleaseId` | CRP 侧 Release ID；这个包还没投出去时为空 |
| `packages[].crpBuildId` | CRP Release 上的 `BuildID`，查 Shuttle 构建任务用它 |
| `packages[].blockedByPackage` | 因哪个上游包失败而被阻断；不是被阻断的为空 |
| `packages[].statusReason` | 失败或阻断的原因，页面直接显示 |
| `crpCalls` | 这条提测最近 50 次 CRP 调用，从新到旧；建 Topic、查软件包、投递、删 Release 都在里面 |

`crpCalls` 覆盖的是**每一次真正发出的请求**，包括重试与失败的请求：连不上时 `statusCode` 为空、
`responseSnippet` 换成失败原因。查库也能核对：`select * from crp_call_log where release_id = '<id>'`。

## POST /api/releases/{id}/dispatch

把一条提测往前推一步。`?action=` 决定做哪件事：

| `action` | 做什么 |
| --- | --- |
| 省略或 `dispatch` | 建 CRP Topic（还没有的话），或者投递下一个该投的软件包 |
| `retry` | 重投失败的构建任务：删掉 CRP 侧旧 Release，按同一份快照参数重投 |
| `cancel` | 取消整个提测：逐个删 Release，再把 Topic 标成已放弃 |

### 鉴权

用用户会话，要「开发者」及以上角色。工作区从提测归属查出，不采信请求体。

### 一次推进做什么

推进是**一次一步、可重复调用**的：

1. 提测还没有 CRP Topic → 在项目选中的基线上建一个，把 Topic ID 写回提测记录（重复调用不会建第二个）；
2. 有 Topic → 先轮询已投递包的构建结果，再按依赖链判定；
3. 有包失败 → 它的全部下游标成阻断并写明原因，提测判 `failed`（一个都没成功）或 `partial_failure`（有成功也有失败）；
4. 否则投递**一个**上游已全部成功的包；
5. 没有可投的包 → 提测置 `building`，等下一次调用。

还有两个细节决定看到的行为：

- **终局要等所有人**：只要还有包在构建，就不判 `success` / `failed` / `partial_failure`。
  否则先投的包失败时，另一个还在构建的包会被一起判掉，它的结果再也写不回来。
- **并发只走一路**：两次推进同时打到同一条提测时，只有一次能去建 Topic 或投某个包，另一次直接
  返回 `action: "waiting"`。所以连点两下「提交」也只会有一个 Topic、一条 Release。
- **中断会自动恢复**：投递发出去之后、写本地记录之前被打断时，那个包会停在「投递中」。超过
  5 分钟（抢占有效期）后的下一次推进会把它退回待投递，先问 CRP 是不是已经收下这个包：
  收下了就补写记录（不再发第二条），没收到才重新投递。

后续步骤由外部定时器调 `POST /api/jobs/build-dispatch` 推进。

### 返回体

`dispatch`：

```json
{
  "action": "dispatched",
  "status": "dispatching",
  "crpTopicId": "29158",
  "packageName": "kwin",
  "blocked": [],
  "polled": { "checked": 0, "succeeded": [], "failed": [], "building": [] }
}
```

`action` 的取值：`idle`（提测已到终局）、`topic_created`、`dispatched`、`finished`、`waiting`。

`retry`：

```json
{
  "action": "retry",
  "resetPackageNames": ["kwin"],
  "unblockedPackageNames": ["dde-dock", "dde-launchpad"],
  "failures": [],
  "advance": { "action": "dispatched", "status": "dispatching", "packageName": "kwin", "blocked": [], "polled": null, "crpTopicId": "29158" }
}
```

`failures` 是**没能重投的包**：删不掉它在 CRP 侧的旧 Release（CRP 连不上，或者那条 Release 已经
被人手工删了）时，这个包保持原状、原因写在这里，其它包照常重投。逐个包处理，不会因为一个包失败就
把整次重试停在半路。

`cancel`：

```json
{
  "action": "cancel",
  "deletedReleaseIds": ["107449", "107450"],
  "abandonedTopicId": "29158",
  "failures": []
}
```

`deletedReleaseIds` 是 CRP 侧实际删掉的 Release；`failures` 是删不掉或放弃不掉的项，带原因。
CRP 没有删除 Topic 的接口，所以「取消」只能是删 Release + 放弃 Topic，Topic 本身仍能在 CRP 里查到
（`Abandoned: true`）。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 动作执行完成 |
| `400` | `invalid_action` | `action` 不是 `dispatch`、`retry`、`cancel` |
| `401` | `unauthenticated` | 未登录 |
| `403` | `forbidden` | 工作区角色低于「开发者」 |
| `404` | `release_not_found` | 提测不存在，或账号不在它所属的工作区 |
| `409` | `conflict` | 没有可重试的失败任务、提测已取消、缺基线分支 ID 等。个别包的重投失败不报错，见 `failures` |
| `502` | `crp_error` | 调 CRP 失败（凭据不对、CRP 拒绝、网络不通），原因看服务端日志与 `crpCalls` |

## POST /api/jobs/build-dispatch

投递的定时入口。本仓库没有常驻调度进程，也没有队列：外部定时器每隔几分钟 POST 一次，把在跑的
提测（`pending`、`dispatching`、`building`）各往前推一步。

### 鉴权

```
Authorization: Bearer <BUILD_DISPATCH_JOB_TOKEN>
```

- token 取自服务端环境变量 `BUILD_DISPATCH_JOB_TOKEN`，与用户会话、`SYNC_JOB_TOKEN`、
  `PACKAGE_API_TOKEN` 都无关。
- 没配置这个变量时接口一律返回 `401`：这个接口会真的向 CRP 建 Topic、发 Release，不能退化成「谁都能触发」。

### 请求体

无。

### 返回

`200`：本轮每条提测的推进结果。

```json
{
  "trigger": "schedule",
  "releaseCount": 2,
  "createdTopics": 0,
  "dispatched": 2,
  "failed": 0,
  "items": [
    {
      "releaseId": "01a1f0c0-…",
      "version": "25.0.2",
      "action": "dispatched",
      "status": "dispatching",
      "packageName": "dde-dock",
      "blocked": [],
      "error": null
    }
  ]
}
```

单条提测推进失败不影响整轮，仍是 `200`：失败原因在 `items[].error` 里，下一轮会再试同一条。
只有整轮都跑不起来（数据库异常）才回 `500`。

### 示例

```bash
# 每 2 分钟推一次（crontab 写法）
*/2 * * * * curl -fsS -X POST -H "Authorization: Bearer $BUILD_DISPATCH_JOB_TOKEN" \
  http://localhost:3000/api/jobs/build-dispatch
```

## GET /api/releases/{id}/update

看这条提测现在能不能改：CRP 工作流进度（现读）、当前每个软件包固化的参数、项目清单里还能补进来的
包，以及每一轮更新留下的记录。

页面 `app/(app)/releases/[id]/update` 直接读同一个函数（`loadReleaseUpdateView`），接口只是同一份
数据的 JSON 版本，A13 的提测详情页合入后可以直接搬过去。

### 鉴权

用用户会话，要「只读」及以上角色。工作区从提测归属查出，不采信查询串。
提测不存在、或账号不在它所属的工作区，都返回 `404 release_not_found`。

### 返回体

`200`：

```json
{
  "releaseId": "01a1f0c0-…",
  "version": "25.0.2",
  "revision": 2,
  "status": "dispatching",
  "projectId": "01a1ee26-…",
  "projectKey": "kwin-project",
  "projectName": "KWin 项目",
  "crpTopicId": "29158",
  "workProgress": 10,
  "workProgressLabel": "更新",
  "workProgressError": null,
  "lockReason": null,
  "packages": [
    {
      "packageName": "kwin",
      "attempt": 2,
      "branch": "develop/eagle",
      "commitSha": "4f0b1d2e…",
      "codeVersion": "5.27.13.0-1",
      "repoVersion": "5.27.12.0-1",
      "releaseVersion": "5.27.12.0",
      "snapshotStatus": "building",
      "crpReleaseId": "107451",
      "crpBuildId": "600209",
      "buildStatus": "building",
      "statusReason": null,
      "blockedByPackage": null,
      "jobs": [{ "arch": "amd64", "status": "building" }]
    }
  ],
  "candidates": [
    { "packageName": "dde-dock", "repoPath": "dde/dde-dock", "trackedBranch": "develop/eagle" }
  ],
  "history": [
    {
      "id": "01a1f120-…",
      "action": "replace",
      "packageNames": ["kwin"],
      "revisionBefore": 1,
      "revisionAfter": 2,
      "abandonedCrpReleaseIds": ["107449", "107450"],
      "redispatchedPackageNames": ["dde-dock", "kwin"],
      "createdAt": "2026-11-19T03:10:31.442Z",
      "operatorName": "张三"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `workProgress` | **现读** CRP 的 `WorkProgress`；`>= 20` 表示已转测，不能再改。读不到时为 `null` |
| `workProgressError` | 读不到进度的原因（连不上、认证失败等） |
| `lockReason` | 现在不能改的原因；能改时为 `null`。判断顺序与 `POST` 的拒绝顺序一致 |
| `packages` | 当前轮的快照：补包/换包只会新起一轮，历史轮次不在这个列表里 |
| `candidates` | 项目软件清单里还没进这条提测的包，补包只能从这里挑 |
| `history` | 每一轮更新的留痕，从新到旧；`action` 是 `append`（补包）或 `replace`（换包） |

## POST /api/releases/{id}/update

更新一条还没转测的提测。

| 请求 | 作用 |
| --- | --- |
| `POST …/update?dryRun=1` | 只算不改：把「将放弃 N 个、重投 N 个」的清单算出来 |
| `POST …/update` | 真正执行：放弃下游 → 新起轮次 → 重投这一条链 |

### 鉴权

用用户会话，要「开发者」及以上角色：这个动作会真的删掉 CRP Release、发出新的投递。

### 请求体

```json
{
  "append": [
    { "packageName": "dde-dock", "branch": "develop/eagle", "commitSha": "4f0b1d2e…", "customTag": null }
  ],
  "replace": [
    { "packageName": "kwin", "branch": "develop/eagle", "commitSha": "9c8b7a6f…", "customTag": null }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `append` | 追加的包：必须已经在项目软件清单里，且此刻不在提测里 |
| `replace` | 换版本的包：必须此刻已经在提测里 |
| `branch` / `commitSha` | 固化的分支与提交；提交必须是 7–40 位十六进制 |
| `customTag` | 提测版本。`replace` 留空表示 **Tag 不变**（只换 Commit 与代码版本）；`append` 留空表示用代码版本 |

两组至少要填一组；同一个包不能既补又换。代码版本由服务端从 Gerrit 现读，不采信请求体。

### 服务端做什么

1. 在事务里 `SELECT … FOR UPDATE` 锁住这条提测（锁等待上限 3 秒），并发的第二次更新排队或收到
   `409`，绝不会两条更新同时改一条提测；
2. 现读 CRP 工作流进度：`>= 20` 拒绝；读不到也拒绝（不默认放行）；
3. 算计划：补包新起第 1 轮；换包新起 `attempt + 1` 轮；按依赖图算出全部**传递**下游
   （多层，菱形也只算一次），清单外的包不参与；
4. 逐个删掉这些包在 CRP 侧的旧 Release。**任何一条删不掉就整体中止**：数据库那半边整体回滚；
   CRP 侧已经删掉的那几条回不来，所以会把对应包的当前轮快照退回 `pending`、提测状态回到
   `dispatching`，由定时器按原快照参数重投，缺的产物会被补回来（不会留下「显示成功、CRP 缺包」）；
5. 一个事务里写新轮、把旧轮标 `superseded` 并指向新轮（不物理删除）、提测轮次加一、
   状态回到 `dispatching`、写一行留痕；
6. 事务提交后调 `advanceRelease` 推进一次，剩下的由外部定时器接着推。

补包不会重投无关的已成功包：只有 `append` 里新加的包与 `replace` 的那条链会重新投递。

### 返回体

`dryRun`：

```json
{
  "action": "preview",
  "plan": {
    "releaseId": "01a1f0c0-…",
    "version": "25.0.2",
    "revisionBefore": 1,
    "revisionAfter": 2,
    "workProgress": 10,
    "workProgressLabel": "更新",
    "rounds": [
      { "packageName": "kwin", "reason": "replace", "supersedesSnapshotId": "01a1f0b0-…", "snapshot": { "packageName": "kwin", "attempt": 2, "branch": "develop/eagle", "commitSha": "9c8b7a6f…", "codeVersion": "5.27.13.0-1", "repoVersion": "5.27.12.0-1", "releaseVersion": "5.27.12.0" } }
    ],
    "abandoned": [{ "packageName": "kwin", "crpReleaseId": "107449" }],
    "order": ["kwin", "dde-dock"],
    "appendedPackageNames": [],
    "replacedPackageNames": ["kwin"],
    "redispatchedPackageNames": ["dde-dock", "kwin"]
  }
}
```

`rounds[].reason` 是 `append`、`replace` 或 `downstream`（换包连带重投的下游）。

正式执行：

```json
{
  "action": "update",
  "revision": 2,
  "abandonedCrpReleaseIds": ["107449"],
  "redispatchedPackageNames": ["dde-dock", "kwin"],
  "plan": { "…": "与 dryRun 的结构一致" },
  "advance": { "action": "dispatched", "status": "dispatching", "packageName": "kwin", "blocked": [], "polled": null, "crpTopicId": "29158" },
  "advanceError": null
}
```

`advanceError` 不为空表示更新**已经提交**、但紧接着的那次推进没成功（例如 CRP 临时连不上）：
提测状态已经回到 `dispatching`，外部定时器会继续推进，重试整次更新反而会重复换包。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 预览或更新完成 |
| `400` | `invalid_json` / `invalid_payload` | 请求体不是 JSON，或校验未通过（字段错误在 `details` 里） |
| `401` | `unauthenticated` | 未登录 |
| `403` | `forbidden` | 工作区角色低于「开发者」 |
| `404` | `release_not_found` | 提测不存在，或账号不在它所属的工作区 |
| `409` | `conflict` | 已转测（`WorkProgress >= 20`）、提测已取消、包不在清单里 / 不在提测里、正在投递、另一个更新正在进行 |
| `502` | `crp_error` | 读不到 CRP 工作流进度，或放弃旧 Release 失败（整次更新已中止：数据库回滚，CRP 侧已删掉的包退回待投递等重投） |

### 示例

```bash
# 先看清单
curl -fsS -X POST -b cookie.txt -H "content-type: application/json" \
  -d '{"replace":[{"packageName":"kwin","branch":"develop/eagle","commitSha":"9c8b7a6f…"}]}' \
  "http://localhost:3000/api/releases/01a1f0c0-…/update?dryRun=1"

# 确认后执行
curl -fsS -X POST -b cookie.txt -H "content-type: application/json" \
  -d '{"replace":[{"packageName":"kwin","branch":"develop/eagle","commitSha":"9c8b7a6f…"}]}' \
  "http://localhost:3000/api/releases/01a1f0c0-…/update"
```

## GET /api/releases/import

从 CRP 导入的第一步「找主题」用。两种用法二选一：

- `?topicId=123`：读一个主题，顺带给出它有多少个 Release；
- `?baselineId=<uuid>&name=<关键字>`：在某条基线（CRP 交付分支）下按名称搜 `test` 类型主题。

### 鉴权

用户会话（httpOnly Cookie），**已登录账号**即可读：主题与 Release 是平台级数据，与基线清单同一口径。

### 返回体

按 ID 读：

```json
{
  "topic": {
    "id": 29123,
    "name": "【FlemingX】缩放需求实时生效联调测试_20261117",
    "branchId": 108,
    "branchName": "eagle-1071",
    "owner": "zhangcailian",
    "type": "test",
    "abandoned": false,
    "completed": false,
    "releaseCount": 4
  }
}
```

按名称搜：

```json
{
  "topics": [
    { "id": 29123, "name": "…", "branchId": 108, "branchName": "eagle-1071",
      "owner": "zhangcailian", "type": "test", "abandoned": false, "completed": false,
      "releaseCount": null }
  ]
}
```

搜索走 `GET /branches/{branchId}/topics?Type=test` 再本地按名称包含匹配（不区分大小写），
最多 50 条；`POST /topics/search` 在这个部署上对任何请求体都返回 `null`，不用它。理由与实测见
`lib/integrations/crp/FINDINGS.md` 第十一节。搜索结果不回 `releaseCount`（要逐条查 Release，代价太大）。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 读到主题，或搜索结果（可以为空数组） |
| `400` | `invalid_query` | 既没给 `topicId`，也没同时给 `baselineId` 与 `name`；`topicId` 不是正整数 |
| `401` | `unauthenticated` | 未登录 |
| `404` | `baseline_not_found` | `baselineId` 不存在 |
| `409` | `baseline_without_branch` | 这条基线没有可用的 CRP 分支 ID |
| `502` | `crp_unavailable` | 读不到 CRP（网络、认证、客户端配置） |

## POST /api/releases/import

把 CRP 上已存在的提测主题导入成一条提测记录。`mode` 必填：

- `mode: "preview"`：只算不写，返回逐包映射预览；卡住的包列在 `blocked` 里，`ready` 为 `false`；
- `mode: "commit"`：真正落库（`release` + 每包一条 `attempt = 1` 的快照 + 每条 CRP Release 的关联记录）。

**整个过程不向 CRP 写任何东西**：只调 `GET /topics/{id}`、`GET /topics/{id}/releases`、
`GET /topics/{id}/workflow/info` 三个读接口。导入后立刻把 `WorkProgress` 写进记录，
`>= 20`（已转测）的记录「更新提测」不可用。

### 鉴权

用户会话，工作区从项目归属查出，**不采信请求体里的工作区**：与 `POST /api/releases` 同一口径
（未登录 `401`、不在工作区 `404 workspace_not_found`、低于「开发者」`403`）。

### 请求体

```json
{
  "projectId": "01a1ee26-82e3-7644-ab2e-a8c9c40fe147",
  "topicId": 29123,
  "mode": "preview",
  "addPackagesToProject": false
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 导入的提测挂在哪个项目 |
| `topicId` | number | 是 | CRP 主题 ID，正整数 |
| `mode` | `"preview"` \| `"commit"` | 是 | 必填，避免「本想预览却真导入了」 |
| `addPackagesToProject` | boolean | 否 | 是否把这些包一并加入项目软件清单，默认 `false` |

### 预览返回体（`mode: "preview"`）

```json
{
  "project": { "id": "…", "key": "v25", "name": "V25 桌面", "baselineId": "…", "baselineName": "eagle-1071" },
  "topic": { "id": 29123, "name": "…", "branchId": 108, "branchName": "eagle-1071",
             "owner": "zhangcailian", "type": "test", "abandoned": false, "completed": false },
  "packages": [
    {
      "packageName": "kwin",
      "packageId": "01a1ee26-…",
      "repoPath": "deepin-kde/kwin",
      "branch": "develop/eagle",
      "commitSha": "17325d43cac4a15abba58dde2136f8e20526f671",
      "commitSource": "crp",
      "codeVersion": "5.27.2.29-deepin29-1",
      "repoVersion": "5.27.11.1",
      "releaseVersion": "5.2.27.29",
      "crpReleaseId": "107449",
      "crpBuildId": "586123",
      "buildState": "UPLOAD_OK",
      "buildStateKnown": true,
      "buildStateNote": null,
      "status": "success",
      "versionMismatch": true
    }
  ],
  "blocked": [],
  "existing": null,
  "ready": true
}
```

| 字段 | 说明 |
| --- | --- |
| `packages[].commitSource` | `crp`（取自 CRP Release 的 Commit）或 `gerrit-tag`（CRP 没给提交号，按 tag 在 Gerrit 反查到） |
| `packages[].releaseVersion` | 提测版本，逐字取自 CRP Release 的 `tag`，不重算 |
| `packages[].packageId` | 为 `null` 表示这次导入会顺手建一条软件包记录（`repoPath` 已由 Gerrit 反查确定） |
| `packages[].buildStateKnown` | `false` 表示 CRP 返回了没见过的构建状态，已按 `pending` 处理，`buildStateNote` 里有说明 |
| `packages[].status` | 快照状态，由 CRP 的 `BuildState` 映射：`UPLOAD_OK` → `success`、`UPLOAD_CRP`/`APPLYING` → `building`、`UPLOAD_GIVEUP` → `failed`、其余 → `pending` |
| `packages[].versionMismatch` | 提测版本与代码版本不同（往往正是要改包的原因） |
| `blocked[].reason` | 这个包为什么不能导入，整次导入停在预览 |
| `existing` | 已导入过这个主题时的已有记录（同一个主题只能导入一次） |
| `ready` | 能不能继续导入：`blocked` 为空且 `existing` 为 `null` |

### 导入返回体（`mode: "commit"`，`201`）

```json
{
  "id": "01a1f2b0-…",
  "version": "5.2.27.29",
  "revision": 1,
  "status": "success",
  "source": "imported",
  "packageCount": 4,
  "autoRegisteredPackages": [],
  "addedToProject": [],
  "workProgress": 20,
  "workProgressLabel": "转测试中（无法更新包）",
  "workProgressError": null,
  "locked": true,
  "packages": [ { "…": "与预览的 packages 同结构，去掉 packageId" } ]
}
```

`version` 取主题里第一条 Release 的 `tag`（主题本身没有版本号，CRP 侧的版本挂在每个 Release 上）。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `201` | — | 导入完成 |
| `400` | `invalid_json` / `invalid_payload` | 请求体不是 JSON，或 `mode` / `projectId` / `topicId` 不合规 |
| `400` | `invalid_request` | 主题不是 `test` 类型 |
| `401` | `unauthenticated` | 未登录 |
| `403` | `forbidden` | 工作区角色低于「开发者」 |
| `404` | `project_not_found` | 项目不存在 |
| `409` | `already_imported` | 这个主题已经导入过；`details.existingReleaseId` / `existingVersion` 指向已有记录，页面据此跳转 |
| `409` | `invalid_request` | 项目已删除、主题已放弃、主题里没有 Release、主题分支与项目基线不一致（错误里点名两个分支）、有包拿不到 Commit / 仓库路径不确定、项目里已有同版本号的提测记录 |
| `502` | `crp_unavailable` | 读不到 CRP（`message` 里带 CRP 的原话） |
| `500` | `internal_error` | 其它未预期错误 |

### 示例

```bash
# 预览：只算不写
curl -fsS -b cookie.txt \
  "http://localhost:3000/api/releases/import?topicId=29123"

# 映射预览
curl -fsS -X POST -b cookie.txt -H "content-type: application/json" \
  -d '{"projectId":"01a1ee26-…","topicId":29123,"mode":"preview"}' \
  "http://localhost:3000/api/releases/import"

# 确认导入
curl -fsS -X POST -b cookie.txt -H "content-type: application/json" \
  -d '{"projectId":"01a1ee26-…","topicId":29123,"mode":"commit"}' \
  "http://localhost:3000/api/releases/import"
```
