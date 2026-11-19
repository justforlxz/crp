# Shuttle 接口探查结论

探查时间：2026-11-18。所有结论都来自当场发出的真实请求，响应片段照录。

## 一、结论先说

**Shuttle 没有「按基线列出全部软件包及其版本」的接口。** 逐路径试过的候选全部 404，见第五节。

可行的路径是把两步拼起来：

1. `GET /api/shuttle/repo/info?type=deb&reponame=<基线>` 拿到该基线仓库的仓库地址（apt 源地址）。
2. 按这个地址去取 `dists/<dist>/<组件>/source/Sources.gz`，解析 `Package` 与 `Version`。

第二步读的是 Shuttle 自己发布的基线仓库索引，不是第三方数据源。一次查询的请求数是「1 + 组件数」，两个测试基线实测组件都只有 1 个，合计 **2 次请求**。

`lib/integrations/shuttle/` 的 `listBaselinePackages` 就按这条路径实现。

## 二、基线仓库软件包版本

### 2.1 第一步：仓库地址

请求：

```http
GET https://shuttle.uniontech.com/api/shuttle/repo/info?type=deb&reponame=eagle-1071
```

响应片段（`repoaddr` 共 829 条，绝大多数是历史 `release-candidate` 地址，这里只取 `name` 为 `release` 的那一条）：

```json
{
  "code": 0,
  "message": "get repo detail info success",
  "data": {
    "reponame": "eagle-1071",
    "repotype": "deb",
    "repoarch": {
      "release": {
        "division": false, "dist": "unstable",
        "arches": ["i386", "arm64", "amd64", "mips64el", "sw_64", "loongarch64", "source"]
      },
      "commit": {
        "division": false, "dist": "experimental",
        "arches": ["i386", "amd64", "mips64el", "sw_64", "loongarch64", "arm64"]
      },
      "release-candidate": {
        "division": true, "dist": "unstable",
        "arches": ["loongarch64", "source", "sw_64", "arm64", "i386", "amd64", "mips64el"]
      }
    },
    "repoaddr": [
      {
        "address": "deb http://aptly-dev.uniontech.com/pkg/eagle-1071/release unstable main",
        "name": "release"
      }
    ]
  }
}
```

`type` 参数不能省。去掉后服务端直接判定参数错误：

```json
{ "code": 1, "message": "get repo detail info fail: DetailRepo: param error" }
```

### 2.2 第二步：源码包索引

由上面那条地址拼出索引地址：

```http
GET http://aptly-dev.uniontech.com/pkg/eagle-1071/release/dists/unstable/main/source/Sources.gz
```

响应：`200`，`60069` 字节，`0.07` 秒。解压后的段落照录两段：

```
Package: kwin
Binary: kwin-common, kwin-data, kwin-dev, kwin-wayland, kwin-x11, libkwineffects14, libkwinglutils14
Version: 4:5.27.2.213-1
Directory: pool/main/k/kwin
...

Package: dde-dock
Version: 5.7.28.2-1
...
```

### 2.3 两个基线的实测结果

| 基线 | 索引地址 | 响应大小 | 耗时 | 软件包数 | `kwin` 版本 |
| --- | --- | --- | --- | --- | --- |
| `eagle-1071` | `.../pkg/eagle-1071/release/dists/unstable/main/source/Sources.gz` | 60 069 字节 | 0.07 秒 | 124 | `4:5.27.2.213-1` |
| `snipe-2500u2` | `.../pkg/snipe-2500u2/release/dists/unstable/main/source/Sources.gz` | 252 459 字节 | 0.16 秒 | 488 | `4:6.1.52` |

`pnpm tsx scripts/verify-shuttle.ts` 对两个基线各查一次的实测输出：

```
=== 基线 eagle-1071 ===
软件包数量：124，耗时 349ms
  abseil 20220623.1-1
  amdgpu-dkms 5.17.32.40513
  apt 1.8.2.20-deepin1
  ...
  kwin 4:5.27.2.213-1
  wayland （该基线仓库里没有）
  dde-dock 5.7.28.2-1

=== 基线 snipe-2500u2 ===
软件包数量：488，耗时 184ms
  7zip 26.02+dfsg-2deepin2
  aalib 1.4p5-51.1deepin1
  ...
  kwin 4:6.1.52
  wayland 1.26.0-1
```

### 2.4 为什么读「源码包」索引而不是「二进制包」索引

需求里的「软件包」指一个代码仓库，例如 `deepin-kde/kwin`（见 PRD 术语表）。二进制包索引里没有 `kwin` 这个名字，只有 `kwin-common`、`kwin-wayland`、`kwin-x11` 等拆分出来的包；`kwin` 只出现在源码包索引里。所以按软件包名查版本必须读 `source/Sources.gz`。

### 2.5 适用范围与备选路径

`name` 为 `release` 的地址指向的是**该基线的交付仓库**，也就是这个基线的软件包发布到这里。实测该仓库里是团队自己的软件包（124 条 / 488 条），跟平台登记的软件包范围一致。

如果后续节点（A9、A11）需要的是「构建机装包时实际看到的全部源」，那就是另一个集合：`repo/info` 返回的 `repobase.archives`，`eagle-1071` 有 8 条。逐条实测代价如下：

| 源 | 索引大小 | 耗时 | 源码包数 |
| --- | --- | --- | --- |
| `pools.uniontech.com/ppa/dde-eagle`（`eagle/1071`，团队 ppa） | 62 863 字节 | 0.05 秒 | 125 |
| `pools.uniontech.com/desktop-professional`（`eagle/1071`，基础系统仓库） | 12 732 749 字节 | 6.05 秒 | 28 736 |

基础系统仓库有 2.8 万个源码包、单次 6 秒，每小时刷新一次每个基线都要付这个代价。当前实现没有把这一层纳入，因为平台登记的软件包都在团队 ppa 侧。**如果 A9 或 A11 需要「构建机看到的全部源」，需要改这里，代价如上表。**

### 2.6 架构列表也在 `repo/info` 里

`repoarch` 的每一项都带一个 `arches` 数组（2026-11-20 实测 `eagle-1071`）：

```
repoarch["release-candidate"].arches
= ["loongarch64","source","sw_64","arm64","i386","amd64","mips64el"]
```

三点要注意：

1. **提测构建走的是 `release-candidate`。** 依据是构建任务的 `action` 字段就是
   `release-candidate`（见第三节的响应片段），所以架构列表也从这一项取，不取 `release` 或 `commit`。
2. **列表里有 `source`。** 它不是 CPU 架构，是源码包索引的「架构」，发给 CRP 只会让 apply 失败，
   使用方要自己去掉。
3. **名字是 `sw_64`、`loongarch64`，不是 `sw64`、`loong64`。** 这一套名字必须原样发给 CRP，
   改名会在 apply 阶段被拒；对照实验见 `lib/integrations/crp/FINDINGS.md` 第十二节。

`getBaselineRepository` 把架构列表与软件包版本放在一次调用里返回，两者共用同一次 `repo/info`，
所以刷新一条基线仍然是 2 次请求。

## 三、构建任务

```http
POST https://shuttle.uniontech.com/api/shuttle/task/list
Content-Type: application/json

{ "params": { "taskid": "600157" }, "pageSize": 5, "current": 1 }
```

响应片段：

```json
{
  "tasks": [
    {
      "key": 600157,
      "pkgname": "kwin",
      "pkgver": "4:6.1.57",
      "reponame": "eagle-1071/44CQ5Y2O5Li6ZmxteOOAkeW5s-WuiembhuWbojEwNzEyMDI1LTExLTI3IDEyOjE5OjI5",
      "action": "release-candidate",
      "hashsum": "fd6b2f3f6389d2ab3e49dd962ce9a5139c44db04",
      "status": "UPLOAD_GIVEUP",
      "status_changed": "2026-11-18 18:58:43 +0800 CST",
      "username": "lijunjie",
      "pkgtype": "deb",
      "jobs": [{ "id": 822491, "arch": "arm64", "status": "FAILED" }]
    }
  ],
  "total": 1
}
```

三个要点，都是实测撞出来的：

1. **`taskid` 必须是字符串。** 传数字 `600157` 时返回 `{"tasks": null, "total": 0}`，什么都不报错，只是查不到。
2. **结果不在 `data` 里。** `tasks` 与 `total` 在最外层，和 `/repo/info` 的 `{code, message, data}` 包装不一样。
3. **`params` 传 `null` 就是不过滤**，按最近构建倒序返回第一页，用来发现最新的构建 ID。

CRP 侧拿到的 `BuildID` 就是这里的 `taskid`：`GET /api/topics/{topic_id}/releases` 返回的 `BuildID` 直接传进来即可。

实测：CRP 主题 29135（`eagle-1071`）的 Release `BuildID=599971` 查回 `wayland 1.26.0.7-1`，1 个作业 `821830`（arm64，`BUILD_OK`）。

## 四、构建日志

```http
GET https://shuttle.uniontech.com/api/shuttle/job/log?jobid=822491
```

响应片段（日志原文约 1 MB，这里截前 200 字）：

```json
{
  "data": "Start Build at 2026-11-18 18:19:35\r\n==> Begin get extra info from shuttle\r\nget extra info success\r\n==> Begin get builder runtime\r\nDistributor ID:\tDeepin\nDescription:\tDeepin 23\n..."
}
```

`data` 是字符串，不是对象。

## 五、探过但不存在的路径

以下路径全部返回 `404 {"message":"Not Found"}`，说明确实没有「按基线列软件包」的接口：

```
GET /api/shuttle/repo/packages?repotype=deb&reponame=eagle-1071
GET /api/shuttle/repo/pkglist?repotype=deb&reponame=eagle-1071
GET /api/shuttle/repo/detail?repotype=deb&reponame=eagle-1071
GET /api/shuttle/repo/package/list?repotype=deb&reponame=eagle-1071
GET /api/shuttle/repo/pkg
GET /api/shuttle/pkg/list?reponame=eagle-1071
GET /api/shuttle/version
GET /api/aptly/repos
GET /api/aptly/repos/eagle-1071
GET /api/aptly/repos/eagle-1071/packages
GET /api/aptly/packages
GET /api/aptly/pkg/eagle-1071
GET /api/aptly/search
GET /api/aptly/snapshot
GET /api/aptly/files
GET /api/aptly/list
GET /api/aptly/repo
```

另外 `/api/swagger/index.html`、`/api/docs`、`/api/routes` 也都是 404，没有可读的接口文档。

Shuttle 前端实际调用的接口是从页面脚本里读出来的，完整清单只有这些：

```
/shuttle/user/login       /shuttle/task/list        /shuttle/task/destroy
/shuttle/task/updateUploadStatus                    /shuttle/job/info
/shuttle/job/log          /shuttle/job/modifyTag    /shuttle/job/rebuild
/shuttle/job/terminate    /shuttle/job/update       /shuttle/slave/list
/shuttle/slave/remove     /shuttle/slave/modify     /shuttle/log/list
/shuttle/batch/list       /shuttle/batch/create     /shuttle/batch/refresh
/shuttle/repo/list        /shuttle/repo/info        /shuttle/repo/create
/shuttle/repo/modify      /shuttle/repo/remove      /aptly/division
/shuttle/help/question    /shuttle/help/question/list
/shuttle/workflow         /shuttle/workflow/delete
```

其中和软件包版本有关的只有 `repo/list`、`repo/info`，两者都只给仓库元信息，不给软件包版本。

## 六、认证

**三个读取接口都不校验身份。** 实测三种情况返回完全一致：

| 请求头 | `/task/list` 结果 |
| --- | --- |
| 不带 `Authorization` | 正常返回任务 |
| `Authorization: Bearer <有效 CRP JWT>` | 正常返回任务 |
| `Authorization: Bearer garbage` | 正常返回任务 |

所以本模块按「不认证」实现，`SHUTTLE_TOKEN` 是可选项：配了才随请求发出，不配也能用。

与 CRP 的分工：

- CRP 的凭据是 LDAP 账号加密码，走 `POST /api/login` 换 JWT，缓存在 `~/.cache/crp/token`。这条链路属于 A2（`lib/integrations/crp/`）。
- Shuttle 自己还有一个 `/shuttle/user/login`（前端登录页在用），但上面三个读取接口不要求它，本模块不调用。
- 两套配置完全分开：这里只读 `SHUTTLE_BASE_URL`、`SHUTTLE_TOKEN`，不碰任何 `CRP_*` 变量，也不复用 CRP 的 token。

## 七、复现方式

```bash
pnpm tsx scripts/verify-shuttle.ts                 # 两个基线各查一次，构建任务用 Shuttle 最近一次构建
pnpm tsx scripts/verify-shuttle.ts 599971 600127   # 指定 CRP Release 里拿到的 BuildID
```

脚本退出码：两个基线都查回不少于 10 个软件包且构建任务段执行完成为 `0`，否则为 `1`。

## 八、构建任务与构建作业的状态取值（2026-11-20 补充）

平台的 `lib/build/status.ts` 只把这里实测见过的值写进明确的分类。这一段记录取值从哪来，加新值前先在这里留下证据。

### 8.1 实测的取值分布

`POST /task/list`，`params` 传 `null`（不过滤）、`pageSize` 50，从 `current=1` 取 10 页（约 500 条最近的构建任务）：

| 任务状态 `status` | 条数 | 作业状态 `jobs[].status` | 条数 |
| --- | --- | --- | --- |
| `UPLOAD_OK` | 363 | `BUILD_OK` | 351 |
| `UPLOAD_FAILED` | 83 | `FAILED` | 62 |
| `UPLOAD_GIVEUP` | 40 | `WAIT` | 38 |
| `APPLY_FAILED` | 10 | `BUILDING` | 28 |
| `UNKNOWN` | 4 | — | — |

这批数据里没有出现 `CONFIG_FAILED`、`SOURCE_FAILED` 这类名字，所以没有按名字相似把它们加进失败集合：没见过的值继续走「算作构建中」的兜底。

### 8.2 `APPLY_FAILED`：CRP 在 apply 阶段拒绝执行

`APPLY_FAILED` 的任务有以下共同点，说明它发生在构建开始之前：

- `jobs` 为 `null`（一个构建作业都没有），`pkgver` 为空；
- 原因写在 `uploadlog` 里，不需要看构建日志；
- 任务建出来了，所以 CRP 侧能看到 `BuildID`，但那条 `BuildID` 下面没有任何架构在跑。

实测样本（同一批数据里的全部 10 条里取 4 条）：

| 任务号 | 包名 | `status_changed`（+0800） | `uploadlog` 摘要 |
| --- | --- | --- | --- |
| 600257 | `uos-remote-assistance` | 2026-11-19 13:10:44 | `exec [[-c dpkg-source -b …]] failed, err: signal: killed` |
| 600216 | `dde-file-manager` | 2026-11-19 01:29:21 | `not support this arch sw64, please check!!!` |
| 600210 | `dde-file-manager` | 2026-11-19 01:20:16 | `not support this arch sw64, please check!!!` |
| 600126 | `deepin-installer-reborn` | 2026-11-18 16:25:27 | `dpkg-source: error: can't build with source format '3.0 (quilt)'…` |

两类原因（架构不支持、打包命令失败）都出现在 apply 阶段，与编译无关。平台侧对这两种原因给出的提示必须指向 Shuttle 任务的 `uploadlog`，而不是让人去翻并不存在的编译日志。

### 8.3 A16 演练的那条 `wayland`

A16 演练（2026-11-19，`eagle-1071`）投出去的 `wayland` Release 对应任务 **600315**，投出约 30 秒后进入 `APPLY_FAILED`，一个构建作业都没起。当时的取值记录：

- 2026-11-19 18:11:59 UTC（北京时间 2026-11-20 02:11:59）`status_changed`，`status` 为 `APPLY_FAILED`；
- CRP 侧同一时刻的 `BuildState` 也是 `APPLY_FAILED`。

2026-11-20 02:26 再查同一条任务，`status` 已经变成 `UPLOAD_FAILED`，`status_changed` 仍是 `2026-11-20 02:11:59`，`uploadlog` 为：

```
ToolDealTaskApply: not support this arch sw64, please check!!!
```

也就是说同一次 apply 阶段的拒绝，Shuttle 用 `APPLY_FAILED` 与 `UPLOAD_FAILED` 两个标签都报过。平台侧两个都判失败，不依赖其中某一个。复现：

```bash
curl -s https://shuttle.uniontech.com/api/shuttle/task/list \
  -X POST -H 'Content-Type: application/json' \
  -d '{"params":{"taskid":"600315"},"pageSize":5,"current":1}'
```

### 8.4 `UNKNOWN` 不是终态

4 条 `UNKNOWN` 的任务都有 `jobs`（例如 `amd64:WAIT`、`arm64:WAIT`），`uploadlog` 只写到「加构建参数」这一步。它是任务刚建出来、作业还在排队的中间态，必须继续等，不能当失败也不能当成功。平台的兜底（未识别状态算构建中）对它正好合适，`lib/build/status.ts` 的单测把这条行为固定住了。
