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
| `crpProjectName` | string | 否 | 这个软件包在 CRP 里的**项目名**，例如 `deepin-kde_kwin`（允许下划线）。留空或传空字符串表示「与包名相同」。不能包含空白字符，长度不超过 100；**允许下划线**（Debian 包名不允许）。 |

单条：

```json
{
  "name": "kwin",
  "repoPath": "deepin-kde/kwin",
  "defaultBranch": "develop/eagle",
  "currentVersion": "5.27.10.2-1",
  "crpProjectName": "deepin-kde_kwin"
}
```

数组：

```json
[
  { "name": "kwin", "repoPath": "deepin-kde/kwin", "defaultBranch": "develop/eagle" },
  { "name": "dde-dock", "repoPath": "deepin/dde-dock", "defaultBranch": "develop/eagle", "currentVersion": "5.11.9-1", "crpProjectName": "dde-dock" }
]
```

### 幂等

以 `name` 为准：库里已有同名包就**更新**它的仓库路径、默认分支、当前版本，不会插出第二条记录。连续提交同一个名字多少次，`package` 表里始终只有一行。

`repoPath` 也唯一：如果这条仓库路径已经被**另一个** `name` 占用，整批返回 `409`。

改动了 `repoPath` 或 `defaultBranch` 时，原先同步到的「当前 Commit」与「最近同步时间」会被清空 —— 它们属于旧分支，留着会误导页面。

`crpProjectName` 改的是「投递时按哪个名字去 CRP 查项目」，是纯配置：它不清空已同步的 Commit 与版本，也不影响已经投出去的 Release。

### 包名与 CRP 项目名不是一回事

两个名字各管一边，平台**不会**假设它们相同：

| 名字 | 谁用 | 规则 |
| --- | --- | --- |
| `name` | Debian 源码包名：`debian/changelog` 解析、基线软件包索引（`baseline_package_version.package_name`）、提测快照 | 小写字母或数字开头，只允许小写字母、数字与 `+` `-` `.`；**不许下划线** |
| `crpProjectName` | 投递 Release 时按它查 CRP 的 `ProjectID`；从 CRP 导入提测时按它落回本地软件包 | 去空白后非空、不含空白字符、长度不超过 100；**允许下划线** |

`crpProjectName` 留空就退回 `name`（与这一列出现之前的行为完全一致）。填了就必须是 CRP 里那个软件包的项目名，否则投递会在查 `ProjectID` 这一步报错：

```json
{
  "error": {
    "code": "crp_error",
    "message": "投递「kwin」，CRP 项目名「deepin-kde_kwin」（软件包 kwin 登记的 CRP 项目名）被 CRP 拒绝：CRP 的交付分支 108 里没有名字完全等于 deepin-kde_kwin 的软件包，无法确定 ProjectID。CRP 返回了相近的名字：…"
  }
}
```

`crpProjectName` 不参与基线软件包版本查询：`baseline_package_version.package_name` 来自 Shuttle 的 Debian 源码包索引，与 CRP 项目名无关。

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

# 包名与 CRP 项目名不同：包名给 Debian 源码包名，crpProjectName 给 CRP 里那个项目的名字
curl -X POST http://localhost:3000/api/packages \
  -H "Authorization: Bearer $PACKAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"kwin","repoPath":"deepin-kde/kwin","defaultBranch":"develop/master","crpProjectName":"deepin-kde_kwin"}'

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
| `packages[].commitSha` | string | 是 | 固化的 Commit，完整的 40 位十六进制提交号（短号投递时会被 CRP 拒绝）；分支名不算 |
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
| `502` | `upstream_unavailable` | 上游读不出来（Gerrit 拒凭据、仓库或提交不存在、changelog 读不到、超时），消息里指出是哪个包；等会儿重试可能就好了，不是请求参数写错 |
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
| `cancel` | 取消整个提测：逐个删 Release，再把 Topic 标成已放弃（前置条件见下一节） |

### `action=cancel` 的前置条件

取消是不可撤销的破坏性动作，服务端按下面几条判定，与页面上的「取消提测」共用同一个函数
（`lib/releases/cancel.ts` 的 `cancelPlatformRelease`）。页面上的按钮禁用只是提示，直接打这个
接口也绕不过去：

- 只对 `source = platform`（平台创建）的提测生效。导入主题里的 Release 是别人投的，`409`
  `conflict`，一条都不删。
- 现读 CRP 工作流进度（`GET /topics/{id}/workflow/info`）。`WorkProgress >= 20`（已转测）`409`
  拒绝；读不到进度同样拒绝，回 `502` `crp_error`，不默认放行。
- 已经取消过的提测 `409`。

判定通过之后逐个删 Release、再放弃 Topic。任何一条删不掉就**不放弃 Topic、本地状态一行不写**，
失败明细放在 `failures` 里；处理完之后直接再调一次即可（删成功的 Release 连同它的仓库记录已经
清掉，重试只碰剩下的）。只有全部成功才把提测写成 `abandoned`。

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
| `409` | `conflict` | 没有可重试的失败任务、提测已取消、缺基线分支 ID 等；`action=cancel` 时还包括「提测是从 CRP 导入的」与「已转测（`WorkProgress >= 20`）」。个别包的重投失败不报错，见 `failures` |
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

单轮最多推进 20 条提测，挑活按 `release.last_advanced_at` 从旧到新（为空的最先）：
活跃提测多于 20 条时是**轮流轮到**，最新创建的提测也会在有限轮次内被推进一次。
不要改回「按创建时间取最早的 20 条」—— 那样后创建的提测永远排在队尾、长期停在「待投递」，
连 Topic 都建不出来（A14 功能检测在 61 条活跃提测下实测复现过）。

每轮顺带清理超过保留期的 CRP 调用记录：`crp_call_log` 只留最近 30 天，见 `docs/DATA_MODEL.md` 4.20。

### 示例

```bash
# 每 2 分钟推一次（crontab 写法）
*/2 * * * * curl -fsS -X POST -H "Authorization: Bearer $BUILD_DISPATCH_JOB_TOKEN" \
  http://localhost:3000/api/jobs/build-dispatch
```

## POST /api/jobs/build-poll

构建状态轮询的定时入口。本仓库没有常驻调度进程，也没有队列：外部定时器每隔几分钟 POST 一次，
把在跑的提测（`pending`、`dispatching`、`building`）各轮询一遍 —— 回写 Shuttle 的构建结果与
CRP 的工作流进度（`release.crpWorkProgress`），并把这一轮做的事记进调度事件流水。

**已完结的提测（`success`、`partial_failure`、`failed`、`abandoned`）不再被轮询**：一条请求都不发。
队列页的「立即轮询」按钮调的是同一段服务端函数，没有第二份轮询逻辑。

### 鉴权

```
Authorization: Bearer <BUILD_POLL_JOB_TOKEN>
```

- token 取自服务端环境变量 `BUILD_POLL_JOB_TOKEN`，与用户会话、`SYNC_JOB_TOKEN`、
  `BUILD_DISPATCH_JOB_TOKEN`、`PACKAGE_API_TOKEN` 都无关。
- 没配置这个变量时接口一律返回 `401`：轮询会改 `crp_work_progress`，而 A17 拿它判断能不能改包，
  入口同样要认人。

### 请求体

无。

### 一次轮询做什么

| 步骤 | 做什么 |
| --- | --- |
| 1 | 按 `build_task` / `build_job` 回写 Shuttle 的构建结果（复用 A12 的 `pollReleaseBuilds`） |
| 2 | 调 `getTopicWorkflow` 把 Topic 的工作流进度写回 `release.crp_work_progress` 与标签 |
| 3 | 把这一轮写进 `build_poll_event`：轮询结果、状态变化、进度同步 |

单轮最多处理 50 条提测，挑活按 `release.last_polled_at` 从旧到新（为空的最先）：
活跃提测多于 50 条时是**轮流轮到**，最新投递的提测下一轮就会被轮到。
这部分不是「只轮询前 50 条」——较早的提测不会饿死，较晚的也不会永远排不上。

两条硬约束：

- **轮询失败不改状态**：Shuttle 超时、CRP 认证失败都只记一条同步错误，`release.status` 与
  `build_task.status` 保持原样 —— 查不到不等于构建失败。
- **取不到工作流进度时保留旧值**：网络错误、认证失败、CRP 回全零对象（`TopicID: 0`、`WorkProgress: 0`）
  都不写 `crp_work_progress`，只记同步错误；绝不写 0，否则 A17 会误以为这条提测还能随意改包。

### 返回

`200`：本轮每条提测的轮询结果。

```json
{
  "trigger": "schedule",
  "releaseCount": 2,
  "polled": 2,
  "failed": 0,
  "items": [
    {
      "releaseId": "01a1f0c0-…",
      "version": "25.0.2",
      "status": "building",
      "checked": 2,
      "succeeded": ["dde-dock"],
      "failed": [],
      "building": ["dde-file-manager"],
      "workProgress": 10,
      "workProgressLabel": "更新",
      "error": null
    }
  ]
}
```

单条提测出错不影响整轮，仍是 `200`：失败原因在 `items[].error` 里，那一提测的状态保持原样，
下一轮会再试同一条。只有整轮都跑不起来（数据库异常）才回 `500`。

### 示例

```bash
# 每 5 分钟轮询一次（crontab 写法）
*/5 * * * * curl -fsS -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN" \
  http://localhost:3000/api/jobs/build-poll
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
| `branch` / `commitSha` | 固化的分支与提交；提交必须是完整的 40 位十六进制 |
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

## GET /api/releases/{id}/abandon

看这条提测的主题现在能不能放弃，以及确认框要显示的两样东西：Topic ID 与主题名。
页面渲染时已经拿到了这些，这个接口是给「不经过页面、直接调接口」的调用方用的：先看一眼，再发 `POST`。

只有 `source = imported` 的提测才可能 `canAbandon = true`：平台自己创建的提测要连 Release 一起清，
走「取消提测」，这一支不提供「放弃提测主题」。`topicName` 只在 `canAbandon = true` 时才现读 CRP
（读不到就是 `null`），其余情况不发这次请求。

### 鉴权

用用户会话，要「只读」及以上角色。工作区从提测归属查出，不采信查询串。
提测不存在、或账号不在它所属的工作区，都返回 `404 release_not_found`。

### 返回体

`200`：

```json
{
  "releaseId": "01a1f0c0-…",
  "source": "imported",
  "status": "building",
  "topicId": "29253",
  "topicName": "kwin-project-25.0.2",
  "workProgress": 10,
  "workProgressLabel": "更新",
  "canAbandon": true,
  "lockReason": null
}
```

`canAbandon` 为 `false` 时 `lockReason` 说明原因（不是导入来源、还没建 Topic、已经放弃过、
读不到工作流进度、已转测）。判定与页面上的禁用是同一个纯函数（`abandonTopicLockReason`），
两处不会各说一套。

## POST /api/releases/{id}/abandon

放弃这条提测的 CRP 主题（MKACG-950）：把 Topic 在 CRP 上置为已放弃，本地状态置 `abandoned`，
并写一行审计（谁、什么时候、放弃的是哪个 Topic）。

**只放弃主题，不删 Release**：主题里已有的 Release 一条都不动，快照也不动。
「逐个删 Release 再放弃 Topic」是 `POST /api/releases/{id}/dispatch?action=cancel`（取消提测），两个动作不能混。

只对 `source = imported`（从 CRP 导入）的提测生效：导入主题里的 Release 是别人投的，只能动主题；
平台自己创建的提测要连 Release 一起清，走「取消提测」。来源不符时服务端直接 `409`，
页面上也不会显示这个入口。

### 鉴权

用用户会话，要「开发者」及以上角色（与创建提测同一档）。工作区从提测归属查出，不采信请求体。
提测不存在、或账号不在它所属的工作区，都返回 `404 release_not_found`。

### 服务端做什么

1. 现读 CRP 工作流进度（`GET /topics/{id}/workflow/info`）。`WorkProgress >= 20`（已转测）直接拒绝；
   读不到进度同样拒绝，不默认放行。库里的 `crp_work_progress` 是上一次轮询的旧值，只用于展示。
2. `GET /topics/{id}` 取回完整主题对象，原样 `PUT /topics/{id}` 回写、只把 `Abandoned` 置 `true`。
   CRP 的 `PUT` 是整体覆盖，只传 `{Abandoned:true}` 会把主题的其它字段改坏（实测依据见
   `lib/integrations/crp/FINDINGS.md`）。`Owner` / `Members` 读回来是对象数组，写回去是逗号拼接的账号名。
3. 写成功之后才在一个事务里改本地：`release.status = abandoned`、`crp_topic_abandoned = true`、
   `finished_at`，并插一行 `release_update_record`（`action = abandon_topic`，带主题 ID）。
   第 2 步失败时本地一步都不写（MUST NOT）。

请求体为空即可：放弃哪一条取自路径里的 `id`，不采信请求体里的任何字段。

### 返回体

`200`：

```json
{
  "action": "abandon_topic",
  "releaseId": "01a1f0c0-…",
  "topicId": "29253",
  "topicName": "kwin-project-25.0.2",
  "abandonedAt": "2026-11-22T07:30:00.000Z"
}
```

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 主题已放弃，本地状态与审计行已写 |
| `401` | `unauthenticated` | 未登录 |
| `403` | `forbidden` | 工作区角色低于「开发者」 |
| `404` | `release_not_found` | 提测不存在，或账号不在它所属的工作区 |
| `409` | `conflict` | 来源不是 `imported`、已转测（`WorkProgress >= 20`）、已经放弃过、还没有建 Topic |
| `502` | `crp_error` | 读不到 CRP 工作流进度，或 `PUT` 失败（本地状态保持原样） |

### 示例

```bash
# 先看要放弃的是哪个主题
curl -fsS -b cookie.txt "http://localhost:3000/api/releases/01a1f0c0-…/abandon"

# 确认后放弃
curl -fsS -X POST -b cookie.txt "http://localhost:3000/api/releases/01a1f0c0-…/abandon"
```

## GET /api/releases/import

从 CRP 导入的第一步「找主题」用。三种用法：

- `?topicId=123`：读一个主题，顺带给出它有多少个 Release；
- `?baselineId=<uuid>&name=<关键字>`：在某条基线（CRP 交付分支）下按名称搜 `test` 类型主题；
- `?baselineId=<uuid>&mine=1`：列出**当前 CRP 账号**在这条基线下当 Owner 的全部 `test` 类型主题，
  不用想关键字 —— 对应 CRP 自己的「查看我的主题」。`mine=1` 时 `name` 可省略，也可以同时给，
  两个条件一起收窄。`name` 与 `mine` 都不给则返回 `400`。

「当前账号」只取服务端 `GET /user` 的返回值，请求里带不了别人的账号。

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

列表（按名称搜与「只看我的主题」同一个返回体）：

```json
{
  "topics": [
    { "id": 29123, "name": "…", "branchId": 108, "branchName": "eagle-1071",
      "owner": "zhangcailian", "type": "test", "abandoned": false, "completed": false,
      "releaseCount": null, "mine": true }
  ],
  "total": 63,
  "limit": 50,
  "truncated": true,
  "currentUser": { "name": "crp-user", "nameCn": "CRP 用户" }
}
```

| 字段 | 含义 |
| --- | --- |
| `topics[].owner` | Owner 的账号名，多人用 `;` 连接，没有 Owner 时为空串 |
| `topics[].mine` | Owner 里有没有当前 CRP 账号；按 ID 读主题、以及没解析账号的关键字搜索为 `null`（未判断） |
| `total` | 截断**之前**的命中条数 |
| `limit` | 单次上限（`TOPIC_SEARCH_LIMIT`，50） |
| `truncated` | `total` 大于实际返回条数时为 `true`，页面据此提示「只显示前 N 条」 |
| `currentUser` | 「只看我的主题」用的当前 CRP 账号；只按关键字搜时为 `null` |

列表按 Topic ID 倒序（最近建的在前）。走 `GET /branches/{branchId}/topics?Type=test` 再本地过滤，
`POST /topics/search` 在这个部署上对任何请求体都返回 `null`，不用它。理由与实测见
`lib/integrations/crp/FINDINGS.md` 第十一节。列表不回真实的 `releaseCount`（要逐条查 Release，代价太大），
`releaseCount` 一律是 `null`。


### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 读到主题，或搜索结果（可以为空数组） |
| `400` | `invalid_query` | 既没给 `topicId`，也没给 `baselineId`；`name` 与 `mine` 都没给；`topicId` 不是正整数 |
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

## GET /api/releases/{id}/export

把一条提测的软件包提交快照导出成 CSV。页面 `/releases/{id}` 的「导出 CSV」与提测记录列表每行的
「导出 CSV」都指向这里。

### 鉴权

用户会话（Cookie）。工作区从提测归属查出，不看查询串里传来的工作区。提测不存在、账号不是这条提测
所属工作区的成员，一律返回 404 —— 不泄露这条提测是否存在。导出只要「只读」权限，因此成员不会因为
角色太低被拒（平台管理员不受成员关系限制）。

### 返回体

`text/csv; charset=utf-8`，带 BOM（Excel 打开中文不乱码），行结束符 `\r\n`。

- 表头固定 11 列，与详情页的快照表逐字一致：
  `提交顺序,软件包/仓库,分支,代码版本,基线仓库版本,本次提测版本,是否自定义 Tag,基线 Commit,本次 Commit,提交说明,提交人`
- 每个软件包一行，顺序与详情页一致（依赖拓扑序，上游在前），只含**这一条**提测的内容。
- `是否自定义 Tag` 按 `releaseVersion !== codeVersion` 判定（没有单独的存储字段）；
  `基线 Commit` 是同一个包在这条提测里上一轮的 Commit，首轮为空，导出为 `—`。
- `提交说明` / `提交人` 用 Commit 号现读 Gerrit；读不到时该格为 `—`，文件照常导出。
- 以 `=`、`+`、`-`、`@`、制表符或回车开头的值会加一个前导单引号（Excel 的「按文本处理」标记），
  避免打开时被当成公式执行；占位符 `—`（U+2014）不受影响。

文件名 `{项目标识}-{提测版本}-r{轮次}.csv`。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` | — | 返回 CSV |
| `401` | `unauthenticated` | 未登录 |
| `404` | `release_not_found` | 提测记录不存在 |
| `404` | `workspace_not_found` | 账号不是这条提测所属工作区的成员（与「不存在」同一口径） |

### 示例

```bash
curl -fsS -b cookie.txt -OJ "http://localhost:3000/api/releases/01a1ee26-…/export"
```

## GET / POST / DELETE /api/settings/credentials

「我的账号」页（`/settings/credentials`）的接口：读写**当前登录用户自己**的 CRP 与 Gerrit 凭据。
契约见 [`.agents/spec/product/credentials.md`](../.agents/spec/product/credentials.md) 第八节。

### 鉴权

用户会话（Cookie），登录即可。账号从会话取，请求体里给不了别人的 ID —— 凭据属于个人，
不存在「管理别人的凭据」。

### 请求体（POST）

```json
{ "kind": "crp", "username": "alice", "secret": "……" }
```

- `kind`：`crp` 或 `gerrit`，其余值 400。
- `username` / `secret` 不能为空。
- **保存前会用这组凭据真实登录一次**：CRP 走 `POST /login`，Gerrit 走 `GET /a/projects/`。
  验证不通过返回 422 与原因，库里不留新记录；已有凭据的人验证失败时只把原因记进
  `last_error`，不动原来的账号名与密文。

### 返回体

```json
{
  "kind": "crp",
  "label": "CRP 账号",
  "configured": true,
  "username": "alice",
  "verifiedAt": "2026-11-24T08:30:00.000Z",
  "lastError": null
}
```

**响应里永远没有密码、密文、初始向量与认证标签。** 查询时就不读这些列，不是靠上层过滤。

`GET` 返回 `{ "credentials": [ ... ] }`，顺序固定为 CRP、Gerrit 两项，未配置的项
`configured: false`、其余字段为 `null`。`DELETE ?kind=crp` 删掉这一类凭据，返回
`{ "kind": "crp", "configured": false }`；本来就没有也算成功。

### 状态码

| 状态码 | `error.code` | 什么情况 |
| --- | --- | --- |
| `200` / `201` | — | 读取 / 保存成功 |
| `400` | `invalid_json` / `invalid_payload` | 请求体不是 JSON / 字段不合法 |
| `401` | `unauthenticated` | 未登录 |
| `409` | `credential_missing` | 这个账号还没配这一类凭据（消息里带配置页地址） |
| `409` | `credential_decrypt_failed` | 库里有密文但解不开（主密钥换了或密文被改过），需要本人重配 |
| `422` | `credential_verify_failed` | 真实登录验证没通过，`message` 是失败原因 |
| `503` | `credential_key_missing` | 服务端没配 `CREDENTIAL_ENCRYPTION_KEY` |

### 示例

```bash
curl -fsS -b cookie.txt http://localhost:3000/api/settings/credentials

curl -fsS -X POST -b cookie.txt -H 'Content-Type: application/json' \
  -d '{"kind":"crp","username":"alice","secret":"……"}' \
  http://localhost:3000/api/settings/credentials

curl -fsS -X DELETE -b cookie.txt \
  'http://localhost:3000/api/settings/credentials?kind=gerrit'
```

## GET /api/crp/projects

当场问一次 CRP：这个名字在 CRP 里对应哪些项目。用于登记软件包时确认「CRP 项目名到底叫什么」，
不写库 —— 这个接口不产生任何 `package` / `baseline` 行。

### 鉴权

用户会话（Cookie），登录即可，不区分工作区角色：查的是 CRP 的数据，不是本平台的数据。
未登录返回 `401`。

CRP 的调用身份是**当前登录用户**自己的 CRP 凭据（在「我的账号」里配置）。没配凭据时
在发出任何 CRP 请求之前就返回 `409 credential_missing`，消息里带配置页地址。

### 查询参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `q` | 是 | 关键词。去掉首尾空白后长度必须 ≥ 1，否则 `400 query_required`，**且不向 CRP 发请求**。 |
| `limit` | 否 | 最多要几条，`1..100`，默认 `100`。不合法时退回默认值，超过 100 压到 100。 |
| `branchId` | 否 | CRP 的交付分支 ID，默认 `0`。**CRP 在这个接口上忽略它**（四个不同分支返回的内容完全一致），传了只为对齐 CRP 的请求格式。 |

CRP 只支持按名字模糊查，`page` 参数被服务端忽略（翻页拿到的是同一批），`perPage` 超过 100 仍是
100 条。所以没有「列出全部 CRP 项目」这种用法。

### 返回体

```json
{
  "items": [
    { "crpProjectName": "kwin-qtrebuild", "packageName": "kwin",
      "repoUrl": "ssh://git@gitlabwh.uniontech.com/wuhan/kelvinu-porting/kwin-5.15.5.5.git",
      "exact": true },
    { "crpProjectName": "dde-kwin", "packageName": "dde-kwin",
      "repoUrl": "ssh://gerrit.uniontech.com:29418/dde-kwin", "exact": false }
  ],
  "truncated": false,
  "query": "kwin"
}
```

| 字段 | 说明 |
| --- | --- |
| `items[].crpProjectName` | CRP 里的项目名，登记时填进「CRP 项目名」。 |
| `items[].packageName` | CRP 里这一项的 Debian 源码包名。**可能是空串**（实测 `kwindowsystem` 就是空），不要假设它非空。 |
| `items[].repoUrl` | CRP 登记的仓库地址。与软件包的 `repoPath` 不是一回事：`repoPath` 是 Gerrit 仓库路径（`deepin-kde/kwin`），要用前先去掉协议与主机。 |
| `items[].exact` | `packageName` 与 `q` 忽略大小写后完全相等。模糊匹配里只有它才是「就是这个名字」。 |
| `truncated` | CRP 返回满 100 条：还有更多没拿到，该换个更具体的关键词。 |
| `query` | 实际使用的关键词（已去掉首尾空白）。 |

排序规则：`exact` 为真的排最前，其余按 `crpProjectName` 长度升序，长度相同按名字排
（同样的输入永远同样的顺序）。

**不返回 CRP 的原始对象。** 精简到上面四个字段，其余字段（`Branches`、`BuildArgs`、`Arches` 等）
不出这个接口。

### 缓存

同一关键词（连同 `limit` / `branchId`）60 秒内复用结果，进程内缓存，最多 200 条，超了淘汰最旧的。
用户每敲一个字就打一次 CRP 既慢又容易触发限流，这层缓存就是为了避免这件事。缓存只在进程里，
重启即失效，不落盘。

### 状态码

| 状态码 | `error.code` | 什么情况 | 用户看到的话 |
| --- | --- | --- | --- |
| `200` | — | 查询成功（包括「一条都没有」） | — |
| `400` | `query_required` | `q` 去空白后为空 | 「请输入要搜索的项目名」 |
| `401` | `unauthenticated` | 未登录 | 「请先登录」 |
| `409` | `credential_missing` | 这个账号还没配 CRP 凭据 | 消息里带「我的账号」配置页地址 |
| `502` | `crp_unavailable` | CRP 回 5xx、连不上，或拒绝了这组凭据 | 「CRP 暂时不可用」/「CRP 拒绝了这次查询的凭据……」 |
| `503` | `crp_rate_limited` | CRP 限流（429） | 「CRP 限流，约 N 秒后再试」，带 `retryAfter` |
| `503` | `credential_key_missing` | 服务端没配 `CREDENTIAL_ENCRYPTION_KEY` | 运维处理 |
| `504` | `crp_timeout` | 等 CRP 响应超时 | 「CRP 响应超时」 |

限流时 `error.retryAfter` 是秒数，同一个值也写进 `Retry-After` 响应头：

```json
{ "error": { "code": "crp_rate_limited", "message": "CRP 限流，约 42 秒后再试", "retryAfter": 42 } }
```

**CRP 的原始报错不会透给前端**（里面有英文原文与内部路径），只进服务端日志。

### 示例

```bash
# 查 kwin 在 CRP 里的项目
curl -fsS -b cookie.txt 'http://localhost:3000/api/crp/projects?q=kwin'

# 只要前 10 条
curl -fsS -b cookie.txt 'http://localhost:3000/api/crp/projects?q=kwin&limit=10'
```
