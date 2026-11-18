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
