# 数据模型（A5 定稿）

本文是 `prisma/schema.prisma` 的说明文档，与 schema 一一对应：21 张表、10 组枚举、全部唯一索引、外键与删除策略都在这里写明。改 schema 必须同步改本文。

其中 4.20（`crp_call_log`）是 A12 追加、4.21（`release_update_record`）是 A17 追加；两张都是只追加的旁证表，不改 A5 已定的字段与索引。

数据来源是 PRD 第五节的领域模型，加上 A2（CRP）、A3（Gerrit）、A4（Shuttle）实测确认的字段。与 PRD 初稿的差异集中记在第 8 节，不在正文里夹带说明。

## 一、全局约定

| 项 | 约定 |
| --- | --- |
| 数据库 | PostgreSQL |
| 表名 | 单数 snake_case；Prisma 侧用 `@@map` 映射 |
| 列名 | snake_case；Prisma 字段用 camelCase，逐个 `@map` 到列名 |
| 主键 | `id`，字符串（`text`），UUID v7，由 Prisma Client 生成。v7 按时间有序，插入时索引局部性好 |
| 时间 | 一律 `timestamptz`（UTC 存储）；列名后缀 `_at`；可变的表带 `created_at` 与 `updated_at`，只追加的表只有 `created_at` |
| 枚举 | PostgreSQL 枚举类型，类型名与 schema 里的枚举名一致（snake_case） |
| 外键 | 列名 `<实体>_id`；每条 `onDelete` 在 schema 里显式写出，策略总表见第 6 节 |
| 账号表 | 表名 `app_user`，避开 SQL 关键字 `user` |
| 删除 | 项目统一软删（`deleted_at`）；提测记录与其快照、构建记录只做状态流转，不物理删除 |

## 二、关系总览

```
workspace 1-n membership n-1 app_user
app_user 1-n session（登录会话；active_workspace_id 不做外键，见 4.4）
workspace 1-n project_manager（project_manager.user_id 可空，指向 app_user）
project_manager 1-n project
project 1-1 baseline（外键 project.baseline_id，单选）
project 1-n project_software n-1 package
package 1-n package_dependency（自关联，记录上游依赖）
baseline 1-n baseline_package_version（数据来自 Shuttle）
project 1-n release
release 1-n release_package_snapshot（按轮次追加）
release_package_snapshot 1-1 release_repository_record（投递后才存在）
release_package_snapshot 1-1 build_task 1-n build_job
release 1-n build_poll_event（调度事件流水，只追加）
workspace 1-n webhook_endpoint 1-n webhook_delivery
sync_run 独立记录同步过程
```

PRD 里的 `Release 1-1 CrpTopic` 在本版没有独立表，Topic 的字段并入 `release`，理由见 8.1。

## 三、枚举

| 枚举（类型名） | 取值 | 用途 |
| --- | --- | --- |
| `WorkspaceRole`（`workspace_role`） | `project_manager`、`developer`、`reader` | 工作区成员角色。平台管理员是账号级标记 `app_user.is_platform_admin`，不进这个枚举 |
| `ReleaseStatus`（`release_status`） | `pending`、`dispatching`、`building`、`success`、`partial_failure`、`failed`、`abandoned` | 提测记录状态。`dispatching` = 正在按依赖顺序投递；`building` = 已投完等构建结果 |
| `ReleaseSource`（`release_source`） | `platform`、`imported` | 提测记录的来源。`platform` = 在本平台按「创建提测」建出来的；`imported` = 从 CRP 已有主题导入（A18）。后续流程两者一致，只在列表与详情上标出来源 |
| `SnapshotStatus`（`snapshot_status`） | `pending`、`dispatching`、`building`、`success`、`failed`、`abandoned`、`superseded` | 提测快照每一轮的状态。`superseded` = 被更晚一轮替换，必有 `superseded_by_id`；`abandoned` = 人为放弃，没有后继 |
| `BuildStatus`（`build_status`） | `pending`、`building`、`success`、`failed`、`canceled` | 构建任务与构建作业共用 |
| `WebhookDeliveryStatus`（`webhook_delivery_status`） | `pending`、`success`、`failed` | Webhook 投递状态 |
| `SyncRunKind`（`sync_run_kind`） | `baseline_list`、`baseline_packages`、`package_metadata`、`release_status` | 同步种类，对应 PRD 6.4 的四类同步边界 |
| `SyncRunStatus`（`sync_run_status`） | `running`、`success`、`failed` | 同步结果 |
| `SyncRunTrigger`（`sync_run_trigger`） | `manual`、`schedule` | 手动刷新或定时任务 |
| `ReleaseUpdateAction`（`release_update_action`） | `append`、`replace` | 提测增量更新的动作：`append` = 补包，`replace` = 换包（含连带重投的下游） |

## 四、表定义

每张表下的「索引」只列唯一索引与显式二级索引（主键索引不重复写）；「外键」写清指向、可空性与删除策略。

### 4.1 workspace（工作区）

项目、成员、Webhook 的隔离边界。用户可属于多个工作区。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | UUID v7 |
| `slug` | text | NOT NULL | 工作区标识，用于 URL |
| `name` | text | NOT NULL | 工作区名称 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`slug` 唯一。
- 外键：无。

### 4.2 app_user（平台账号）

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `email` | text | NOT NULL | 登录账号 |
| `passwordHash`（`password_hash`） | text | NOT NULL | 只存哈希，不存明文 |
| `displayName`（`display_name`） | text | NOT NULL | 显示名 |
| `isPlatformAdmin`（`is_platform_admin`） | boolean | NOT NULL，默认 false | 平台管理员，可访问全部工作区 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`email` 唯一。
- 外键：无。

### 4.3 membership（工作区成员）

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `workspaceId`（`workspace_id`） | text | NOT NULL | |
| `userId`（`user_id`） | text | NOT NULL | |
| `role` | `workspace_role` | NOT NULL | 该用户在此工作区的角色 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(workspace_id, user_id)` 唯一；`user_id` 二级索引（查「我在哪些工作区」）。
- 外键：`workspace_id → workspace.id`，RESTRICT；`user_id → app_user.id`，RESTRICT。工作区与账号都不做物理删除，历史成员关系必须留着。

### 4.4 session（登录会话）

登录会话。Cookie 里只放随机令牌，表里只存令牌的 SHA-256，服务端可随时撤销。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | UUID v7 |
| `userId`（`user_id`） | text | NOT NULL | 会话所属账号 |
| `tokenHash`（`token_hash`） | text | NOT NULL | 令牌的 SHA-256 十六进制；库里没有令牌本身 |
| `activeWorkspaceId`（`active_workspace_id`） | text | NULL | 当前选中的工作区；为空表示还没选过 |
| `expiresAt`（`expires_at`） | timestamptz | NOT NULL | 过期时间，滑动续期时往后推 |
| `revokedAt`（`revoked_at`） | timestamptz | NULL | 撤销时间；非空即失效，行保留供排查 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`token_hash` 唯一（按 Cookie 值查会话）；`user_id` 二级索引（撤销某账号全部会话）；`expires_at` 二级索引（清理过期行）。
- 外键：`user_id → app_user.id`，CASCADE（账号删除时会话一起删，且只有这一处允许 CASCADE）。
- `active_workspace_id` **不建外键**：工作区归属的权威来源是 `membership`，越权读取由应用层判定成 404；会话里只是一个「上次选的工作区」标记，工作区被删时残留的值只会让下一次读取找不到成员关系，不影响安全。
- 令牌有效期 7 天，每次读取会话时滑动续期（最多每小时写一次库）。

### 4.5 project_manager（项目经理）

项目归属的载体，归属于一个工作区。每个项目必须指定一位。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `workspaceId`（`workspace_id`） | text | NOT NULL | 项目经理归属的工作区 |
| `userId`（`user_id`） | text | NULL | 绑定的平台账号；未开通账号时为空 |
| `name` | text | NOT NULL | 展示用姓名 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(workspace_id, name)` 唯一（同一工作区内不重名，避免同名项目经理无法区分）；`workspace_id` 二级索引。
- 外键：`workspace_id → workspace.id`，RESTRICT；`user_id → app_user.id`，SET NULL（账号注销时保留项目经理实体，只解除绑定）。

### 4.6 baseline（CRP 基线）

CRP `/branches` 返回的一条交付分支。平铺清单，不分类，不做命名映射。

字段来自 A2 实测：`ID`、`Name`、`Description`、`RepoType`、`IsCheck`。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `crpBranchId`（`crp_branch_id`） | text | NOT NULL | CRP 侧分支 ID（`/branches` 的 `ID`） |
| `name` | text | NOT NULL | 分支名，例如 `eagle-1071`、`snipe-2500u2` |
| `description` | text | NULL | CRP 侧描述，原样保存 |
| `repoType`（`repo_type`） | text | NULL | CRP 侧仓库类型，例如 `deb` |
| `isCheck`（`is_check`） | boolean | NOT NULL，默认 false | CRP 的 `IsCheck`，数值 1 与布尔 true 都归一成 true |
| `syncedAt`（`synced_at`） | timestamptz | NULL | 最近一次同步成功时间；为空或过旧即「基线未同步」 |
| `missingAt`（`missing_at`） | timestamptz | NULL | 从 CRP `/branches` 里消失的时间；为空表示这条分支目前仍在 CRP 里 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`crp_branch_id` 唯一。
- 外键：无。
- 消失不删行：项目可能还指着这条基线、历史提测记录也要查得到它，所以同步只写 `missing_at`；分支重新出现时清空。
- 状态（已同步 / 同步失败 / 未同步 / 已消失）不单独存列，由 `missing_at`、`synced_at` 与该基线最近一次 `sync_run`（`kind = baseline_packages`）的结果算出，见 `lib/baselines/status.ts`。
- `crp_branch_id` 必须是 CRP `/branches` 返回的真实 ID，不能拿分支名里的数字凑：CRP 的 ID 与分支名无关（`eagle-1071` 的 ID 是 108），凑出来的 ID 会让同一分支在库里出现两条。

### 4.7 baseline_package_version（基线内软件包版本）

数据来自 Shuttle 的基线交付仓库索引（A4 的 `listBaselinePackages`），按周期同步覆盖。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `baselineId`（`baseline_id`） | text | NOT NULL | 所属基线 |
| `packageName`（`package_name`） | text | NOT NULL | 源码包名，例如 `kwin`，与 `package.name` 同一套命名 |
| `version` | text | NOT NULL | 该包在此基线交付仓库里的当前版本，原样保存 |
| `fetchedAt`（`fetched_at`） | timestamptz | NOT NULL | 本条数据的同步时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(baseline_id, package_name)` 唯一，同步时按它覆盖写入。
- 外键：`baseline_id → baseline.id`，CASCADE。基线的包版本清单属于基线自身，基线删除时一并清掉。
- 不指向 `package`：基线里存在大量平台尚未登记的软件包（`eagle-1071` 实测 124 个、`snipe-2500u2` 488 个）。需要关联时按 `package_name = package.name` 查。

### 4.8 package（软件包）

一个代码仓库，全局唯一登记。依赖只在 `package_dependency` 维护，项目清单不重复存依赖。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `name` | text | NOT NULL | 源码包名，例如 `kwin` |
| `repoPath`（`repo_path`） | text | NOT NULL | 仓库路径，例如 `deepin-kde/kwin` |
| `defaultBranch`（`default_branch`） | text | NOT NULL | 默认跟踪分支，例如 `develop/eagle` |
| `currentVersion`（`current_version`） | text | NULL | 当前版本。登记时填写；元数据同步成功后更新为所跟踪分支 `debian/changelog` 的版本 |
| `currentCommit`（`current_commit`） | text | NULL | 当前 Commit。元数据同步成功后写入所跟踪分支的最新提交；换仓库或换默认分支时清空 |
| `lastSyncedAt`（`last_synced_at`） | timestamptz | NULL | 最近一次元数据同步成功的时间；为空表示从未同步 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`name` 唯一；`repo_path` 唯一。
- 外键：无。

### 4.9 package_dependency（软件包上游依赖）

一行表示「下游包依赖上游包」：上游构建成功才允许投递下游。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `packageId`（`package_id`） | text | NOT NULL | 下游包 |
| `upstreamPackageId`（`upstream_package_id`） | text | NOT NULL | 上游包 |
| `createdAt` | timestamptz | NOT NULL | |

- 索引：`(package_id, upstream_package_id)` 唯一；`upstream_package_id` 二级索引（查「谁依赖我」，A17 作废下游要用）。
- 外键：`package_id → package.id`、`upstream_package_id → package.id`，都是 RESTRICT。删软件包前必须先清依赖，避免依赖链断在半路。
- 依赖环（含自依赖）由应用层在保存时检测。数据库只挡得住主键与外键，环检测是图算法，不放在数据库里。

### 4.10 project（项目）

一次提测的归属对象。归属只由「项目经理 + 工作区」决定，**没有任何业务类型字段**（没有「主线 / 商业项目」这类分类）。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `workspaceId`（`workspace_id`） | text | NOT NULL | |
| `projectManagerId`（`project_manager_id`） | text | NOT NULL | 每个项目必须有一位项目经理 |
| `baselineId`（`baseline_id`） | text | NOT NULL | 单选，一个项目同一时间只有一个目标基线 |
| `key` | text | NOT NULL | 项目标识，用于 URL 与外部引用 |
| `name` | text | NOT NULL | 项目名称 |
| `description` | text | NULL | |
| `deletedAt`（`deleted_at`） | timestamptz | NULL | 软删时间；非空即已删除，列表默认过滤 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(workspace_id, name)` 唯一；`(workspace_id, key)` 唯一；`project_manager_id`、`baseline_id` 二级索引。
- 外键：`workspace_id → workspace.id`、`project_manager_id → project_manager.id`、`baseline_id → baseline.id`，全部 RESTRICT。
- 删除策略：项目只软删（写 `deleted_at`），不物理删除。历史提测记录必须能继续查到自己的项目，所以外键不会因为「删项目」而触发任何连锁删除。

### 4.11 project_software（项目软件清单）

项目引用了哪些软件包、各自跟踪哪个分支。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `projectId`（`project_id`） | text | NOT NULL | |
| `packageId`（`package_id`） | text | NOT NULL | |
| `trackedBranch`（`tracked_branch`） | text | NOT NULL | 本项目默认跟踪分支，可覆盖软件包默认分支 |
| `lastSubmittedCommit`（`last_submitted_commit`） | text | NULL | 上次提测成功时提交的 Commit |
| `lastSubmittedAt`（`last_submitted_at`） | timestamptz | NULL | 上次提测成功时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(project_id, package_id)` 唯一；`package_id` 二级索引。
- 外键：`project_id → project.id`、`package_id → package.id`，都是 RESTRICT。
- `last_submitted_commit` 只在提测创建成功后更新，刷新分支不影响它。
- 复制项目（A10）按本表逐行复制 `package_id` 与 `tracked_branch`，`last_submitted_commit` 与
  `last_submitted_at` 写入空值：副本还没提过测，继承源项目的提交号会让「有没有更新」从一开始就判断错。

### 4.12 release（提测记录）

一次提测。CRP 侧对应一个 Topic，本表同时保存该 Topic 的本地状态副本。

**为什么 Topic 状态要落在库里**：CRP 没有删除 Topic 的接口（`DELETE /api/topics/{id}` 返回 200 但不做事），清理只能把 Topic 置 `Abandoned`。「这个 Topic 还能不能再用」必须是本地查得到的事实，不能需要时去 CRP 现问。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `projectId`（`project_id`） | text | NOT NULL | 提测归属项目 |
| `version` | text | NOT NULL | Topic 版本号，提测时填写 |
| `revision` | integer | NOT NULL，默认 1 | 提测轮次，从 1 开始；每次增量更新加一 |
| `status` | `release_status` | NOT NULL，默认 `pending` | 提测状态 |
| `source` | `release_source` | NOT NULL，默认 `platform` | 提测来源：平台创建 / 从 CRP 主题导入 |
| `description` | text | NULL | 提测说明 |
| `createdById`（`created_by_id`） | text | NOT NULL | 发起人 |
| `crpTopicId`（`crp_topic_id`） | text | NULL | CRP 侧 Topic ID；建 Topic 之前为空 |
| `crpBranchId`（`crp_branch_id`） | text | NULL | 建 Topic 时使用的 CRP 基线分支 ID |
| `crpTopicState`（`crp_topic_state`） | integer | NULL | CRP Topic 的 `State` 数值，原样保存 |
| `crpTopicAbandoned`（`crp_topic_abandoned`） | boolean | NULL | Topic 是否已放弃 |
| `crpTopicCompleted`（`crp_topic_completed`） | boolean | NULL | Topic 是否已完成 |
| `crpWorkProgress`（`crp_work_progress`） | integer | NULL | CRP 工作流进度数值；`>= 20` 表示已转测，不允许再改包 |
| `crpWorkProgressLabel`（`crp_work_progress_label`） | text | NULL | 进度对应的中文标签，与数值一起存 |
| `crpWorkProgressSyncedAt`（`crp_work_progress_synced_at`） | timestamptz | NULL | 进度最近一次回写时间 |
| `submittedAt`（`submitted_at`） | timestamptz | NULL | 全部软件包投递完成时间 |
| `finishedAt`（`finished_at`） | timestamptz | NULL | 提测结束（成功或失败）时间 |
| `lastPolledAt`（`last_polled_at`） | timestamptz | NULL | 最近一次被构建轮询看到的时间（A14 追加）；轮询按它从旧到新挑活，为空的最先 |
| `rollbackOfId`（`rollback_of_id`） | text | NULL | **v2 预留**，本版无流程 |
| `codeSourceReleaseId`（`code_source_release_id`） | text | NULL | **v2 预留**，本版无流程 |
| `riskFlag`（`risk_flag`） | boolean | NULL | **v2 预留**，本版无流程 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(project_id, version)` 唯一；`crp_topic_id` 唯一（同一条记录只能绑一个 Topic）；`status`、`created_at` 二级索引（列表与工作台统计按状态、时间过滤）。
- 外键：`project_id → project.id`，RESTRICT；`created_by_id → app_user.id`，RESTRICT。
- 不额外建 `project_id` 单列索引：`(project_id, version)` 唯一索引的最左前缀已经覆盖按项目查询。
- v2 的三个预留字段**不建外键**：本版没有回退流程，指向关系暂时没有写入方；等 v2 真正实现时再加约束。
- `last_polled_at` 只加一列、不加索引：轮询先按 `status`（已有索引）过滤到在跑的少量提测，再排序，
  开销可以忽略；它的作用是让「单轮只处理固定条数」不至于变成「最新投递的永远轮不到」。
  轮询失败也会写这一列（表示这一轮看过它了），否则一条一直失败的提测会占住队首。

### 4.13 release_package_snapshot（提测快照）

某一轮里某个软件包固化的分支、Commit 与三个版本号。

**追加式建模**：同一个软件包再次提测时新增一轮（`attempt` 加一），**旧轮一行不改、不删**。历史轮次用 `superseded_by_id`、`superseded_at` 指向替换它的新轮。修正是追加新轮，不是原地修改。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NOT NULL | 所属提测 |
| `packageName`（`package_name`） | text | NOT NULL | 源码包名，例如 `kwin`；按名字快照，未登记的包也能进快照 |
| `attempt` | integer | NOT NULL | 该包在这个提测里的第几轮，从 1 开始 |
| `branch`（`branch`） | text | NOT NULL | 固化的分支 |
| `commitSha`（`commit_sha`） | text | NOT NULL | 固化的 Commit |
| `codeVersion`（`code_version`） | text | NOT NULL | 所选 Commit 的 `debian/changelog` 版本 |
| `repoVersion`（`repo_version`） | text | NULL | 该基线交付仓库里当前已有的版本（Shuttle 取），查不到时为空 |
| `releaseVersion`（`release_version`） | text | NOT NULL | 本次提交给 CRP 的版本（CRP 的 Tag） |
| `status` | `snapshot_status` | NOT NULL，默认 `pending` | 本轮状态，允许流转 |
| `statusChangedAt`（`status_changed_at`） | timestamptz | NULL | 状态最后一次变化时间，轮询回写时更新 |
| `supersededById`（`superseded_by_id`） | text | NULL | 被哪一轮替换；被替换的旧轮指向新轮 |
| `supersededAt`（`superseded_at`） | timestamptz | NULL | 被替换的时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(release_id, package_name, attempt)` 唯一；`superseded_by_id` 唯一（一条新轮只接替一轮）；`(release_id, status)` 二级索引（详情页按状态分组）。
- 外键：`release_id → release.id`，RESTRICT；`superseded_by_id → release_package_snapshot.id`（自关联），RESTRICT。
- **可变字段只有四个**：`status`、`statusChangedAt`、`supersededById`、`supersededAt`。其余业务字段（分支、Commit、三个版本号、`attempt`）创建后不得修改，应用层不提供更新入口。
- `dispatching` 是 A12 的抢占状态：某一轮推进把它从 `pending` 改成 `dispatching` 之后才去调 CRP 投递，
  抢不到的那一次推进不会重复发 Release。投递成功后转 `building`。
- 从 `dispatching` 退回来有两条路，覆盖的失败不同：
  1. `submitRelease` 自己抛错（CRP 拒绝、连不上、参数非法）→ 当场退回 `pending`，下一次推进重投；
  2. 投递发出去了、但写库那一步失败或被进程中断 → 快照停在 `dispatching`，超过抢占有效期
     （5 分钟）后由 `releaseStaleClaims` 退回 `pending`；重新投递之前会先问一趟 CRP，
     已经有同一个包、分支、Commit、提测版本的 Release 就直接认领、补写记录，不再发第二条。
  所以「停在 `dispatching`」不是死状态，但第 2 条的恢复要等一个抢占周期，不会立刻发生。

### 4.14 release_repository_record（提测与 CRP 仓库记录的关联）

一轮快照投递成功后，CRP 侧的 Release 与仓库地址。

`release_id` 是为按提测查询冗余出来的，权威归属是 `snapshot_id`。冗余的理由：换包会删掉旧的 CRP Release 再建新的，历史轮次的记录必须能跟着提测一起查到，且每轮一行。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NOT NULL | 冗余的提测归属，便于按提测查 |
| `snapshotId`（`snapshot_id`） | text | NOT NULL | 权威归属：具体那一轮快照 |
| `crpReleaseId`（`crp_release_id`） | text | NOT NULL | CRP 侧 Release ID |
| `crpBuildId`（`crp_build_id`） | text | NULL | CRP Release 上的 `BuildID`；查 Shuttle 构建任务用它，**必须按字符串传**（传数字会静默返回空，A4 实测） |
| `crpReleaseState`（`crp_release_state`） | integer | NULL | CRP 侧 Release 状态数值 |
| `crpStatusName`（`crp_status_name`） | text | NULL | CRP 侧状态名，原样保存 |
| `repositoryUrl`（`repository_url`） | text | NULL | 从 `/topic_urls` 查到的仓库地址；构建产出前为空 |
| `lastSyncedAt`（`last_synced_at`） | timestamptz | NULL | 最近一次从 CRP 刷新状态的时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`snapshot_id` 唯一（一轮只对应一条 CRP Release）；`crp_release_id` 唯一。
- 外键：`release_id → release.id`、`snapshot_id → release_package_snapshot.id`，都是 RESTRICT。改包时旧的 CRP Release 在 CRP 侧被删，本地这条记录保留，用于复盘。

### 4.15 build_task（构建任务）

一个软件包在**一轮快照**上的一次构建，不挂在软件包上。任务 ID 就是 CRP Release 的 `BuildID`（A4 实测：Shuttle 的 `taskid` 取这个值）。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NOT NULL | 冗余的提测归属，供按提测查队列 |
| `snapshotId`（`snapshot_id`） | text | NOT NULL | 权威归属：具体那一轮快照 |
| `shuttleTaskId`（`shuttle_task_id`） | text | NULL | Shuttle 侧任务 ID；还没查到构建时为空 |
| `status` | `build_status` | NOT NULL，默认 `pending` | 构建状态 |
| `blockedBySnapshotId`（`blocked_by_snapshot_id`） | text | NULL | 因哪个上游快照失败而阻断（A12 追加）；不是被阻断的为空。不建外键，见 4.20 的同一处理方式 |
| `statusReason`（`status_reason`） | text | NULL | 给人看的失败或阻断原因，例如「因上游 kwin 构建失败而阻断」（A12 追加） |
| `lastPolledAt`（`last_polled_at`） | timestamptz | NULL | 最近一次向 Shuttle 查询结果的时间 |
| `startedAt`（`started_at`） | timestamptz | NULL | 构建开始时间 |
| `finishedAt`（`finished_at`） | timestamptz | NULL | 构建结束时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`snapshot_id` 唯一（一轮快照一个任务）；`shuttle_task_id` 唯一；`release_id`、`status` 二级索引（构建队列页按提测与状态过滤）。
- 外键：`release_id → release.id`、`snapshot_id → release_package_snapshot.id`，都是 RESTRICT。

### 4.16 build_job（构建作业）

一个构建任务下某个架构的一次编译，构建日志按 `shuttle_job_id` 查。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `buildTaskId`（`build_task_id`） | text | NOT NULL | 所属构建任务 |
| `shuttleJobId`（`shuttle_job_id`） | text | NOT NULL | Shuttle 侧 job ID |
| `arch` | text | NOT NULL | 架构，例如 `amd64`、`arm64` |
| `status` | `build_status` | NOT NULL，默认 `pending` | 作业状态 |
| `startedAt` / `finishedAt` | timestamptz | NULL | 作业起止时间 |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`shuttle_job_id` 唯一；`build_task_id` 二级索引。
- 外键：`build_task_id → build_task.id`，**CASCADE**。作业是任务的组成部分，没有独立含义；删任务时连带删作业。

### 4.17 webhook_endpoint（Webhook 端点）

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `workspaceId`（`workspace_id`） | text | NOT NULL | 端点归属的工作区 |
| `name` | text | NOT NULL | 端点名称，页面显示用；同一工作区内不要求唯一 |
| `url` | text | NOT NULL | 回调地址 |
| `secret` | text | NOT NULL | 签名密钥；只在投递时使用，不进日志、不回显 |
| `eventTypes`（`event_types`） | text[] | 默认空数组 | 订阅的事件类型，取值见 `lib/webhook/events.ts` 的五项清单与 `docs/WEBHOOK.md` |
| `enabled` | boolean | NOT NULL，默认 true | 停用后不再投递，但保留记录 |
| `description` | text | NULL | |
| `createdAt` / `updatedAt` | timestamptz | NOT NULL | |

- 索引：`(workspace_id, url)` 唯一（同一工作区不重复注册同一地址）。
- 外键：`workspace_id → workspace.id`，RESTRICT。

### 4.18 webhook_delivery（Webhook 投递记录）

每次投递的载荷、签名与结果，用于复算签名与排查失败。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `endpointId`（`endpoint_id`） | text | NOT NULL | 目标端点 |
| `eventType`（`event_type`） | text | NOT NULL | 事件类型 |
| `payload` | jsonb | NOT NULL | 投递内容原文 |
| `signature` | text | NOT NULL | 本次签名，用于复算校验 |
| `status` | `webhook_delivery_status` | NOT NULL，默认 `pending` | 投递状态 |
| `attempts` | integer | NOT NULL，默认 0 | 已尝试次数（含首次），最多 5 次 |
| `lastError`（`last_error`） | text | NULL | 最近一次失败原因 |
| `httpStatus`（`http_status`） | integer | NULL | 最近一次尝试收到的 HTTP 状态码；连接失败等拿不到状态码时为空 |
| `durationMs`（`duration_ms`） | integer | NULL | 最近一次尝试的耗时（毫秒） |
| `responseSnippet`（`response_snippet`） | text | NULL | 最近一次尝试的响应体摘要，入库前截断到 500 字 |
| `createdAt`（`created_at`） | timestamptz | NOT NULL | 记录创建时间 |
| `deliveredAt`（`delivered_at`） | timestamptz | NULL | 成功投递时间 |

- 索引：`(endpoint_id, status)` 二级索引（按端点看重试队列）；`created_at` 二级索引（投递日志按时间翻页）。
- 外键：`endpoint_id → webhook_endpoint.id`，RESTRICT。端点只停用不删除，投递日志要能一直追溯。
- 一次投递一行：`attempts` 记已尝试次数，`http_status`、`duration_ms`、`response_snippet`、`last_error` 都是最近一次尝试的结果；5 次尝试的逐次记录写进程日志，不在库里展开成 5 行。

### 4.19 sync_run（同步任务记录）

一次同步的过程与结果，只记过程，同步到的数据落在各自的目标表（`baseline`、`baseline_package_version`、`release` 等）。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `kind` | `sync_run_kind` | NOT NULL | 同步种类 |
| `status` | `sync_run_status` | NOT NULL，默认 `running` | 同步结果 |
| `trigger` | `sync_run_trigger` | NOT NULL | 手动或定时 |
| `targetId`（`target_id`） | text | NULL | 同步范围：基线类同步存 `baseline.id`，提测状态同步存 `release.id`，全局同步为空 |
| `itemCount`（`item_count`） | integer | NOT NULL，默认 0 | 处理条数 |
| `startedAt`（`started_at`） | timestamptz | NOT NULL，默认当前时间 | 开始时间 |
| `finishedAt`（`finished_at`） | timestamptz | NULL | 结束时间 |
| `errorMessage`（`error_message`） | text | NULL | 失败原因 |
| `createdAt`（`created_at`） | timestamptz | NOT NULL | |

- 索引：`(kind, started_at)` 二级索引（按种类看最近一次同步）；`status` 二级索引（找卡在 `running` 的任务）。
- 外键：无。`target_id` 故意不加外键：它按 `kind` 指向不同的表，外键表达不了这种多态。

### 4.20 crp_call_log（CRP 调用记录）

每一次真正发往 CRP 的请求留一行（A12 追加）。设计契约要求「每次对 CRP 的调用都有请求记录
（URL、耗时、状态、响应摘要）可查」，没有这张表就只能翻进程日志。

记录点在请求层（`lib/integrations/crp/request.ts` 的 `onRequest` 回调），不在各个调用点上：
重试的每一次、登录请求、被拒的请求都会留记录，逐个调用点手工记一定会漏。重试一次就是一行。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NULL | 发起这次调用的提测；登录、查分支这类不属于任何提测的调用为空 |
| `snapshotId`（`snapshot_id`） | text | NULL | 这次调用服务于哪一轮快照；建 Topic、放弃 Topic 这类不针对单个包的调用为空 |
| `method` | text | NOT NULL | HTTP 方法 |
| `url` | text | NOT NULL | 完整地址，含接口前缀与查询串 |
| `statusCode`（`status_code`） | integer | NULL | HTTP 状态码；连不上或超时这类没有响应的情况为空 |
| `durationMs`（`duration_ms`） | integer | NOT NULL | 本次请求耗时（毫秒） |
| `responseSnippet`（`response_snippet`） | text | NULL | 响应体摘要，入库前截断到 500 字；没有响应时是失败原因 |
| `createdAt`（`created_at`） | timestamptz | NOT NULL | 记录时间 |

- 索引：`(release_id, created_at)` 二级索引（按提测看请求时间线）；`snapshot_id` 二级索引（按包看）。
- 外键：无。`release_id`、`snapshot_id` 故意不加外键，与 `session.active_workspace_id` 同一处理方式：
  这是排查用的旁证，不该被提测记录、快照的清理策略牵住；按值查询已经够用。

### 4.21 release_update_record（提测增量更新留痕）

「每轮变更留痕：谁、什么时候、加了什么、放弃了什么、重投了什么」（A17 追加）。
现有表里没有能承载人工操作的落点：`sync_run` 是同步类记录（基线、软件包元数据、提测状态），
语义不同，所以单独建一张。

一次更新请求最多写两行：有补包就写一行 `append`，有换包就写一行 `replace`，一行只描述一类动作，
页面按时间倒序列出即可。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NOT NULL | 所属提测 |
| `operatorId`（`operator_id`） | text | NOT NULL | 发起这次更新的账号 |
| `action` | `release_update_action` | NOT NULL | `append`（补包）或 `replace`（换包） |
| `packageNames`（`package_names`） | text[] | NOT NULL | 本次涉及的包名：补包是新加的包，换包是被换版本的包 |
| `revisionBefore`（`revision_before`） | integer | NOT NULL | 更新前的提测轮次 |
| `revisionAfter`（`revision_after`） | integer | NOT NULL | 更新后的提测轮次（当前实现是加一） |
| `abandonedCrpReleaseIds`（`abandoned_crp_release_ids`） | text[] | NOT NULL | 本次在 CRP 侧放弃（删除）的 Release ID |
| `redispatchedPackageNames`（`redispatched_package_names`） | text[] | NOT NULL | 本次重投的包名：补包是新加的那些，换包是被换的包加全部传递下游 |
| `createdAt`（`created_at`） | timestamptz | NOT NULL | 记录时间 |

- 索引：`(release_id, created_at)` 二级索引（按提测看更新历史）。
- 外键：`release_id → release.id`、`operator_id → app_user.id`，都是 RESTRICT。
- 两个列表列存包名与 Release ID 的原文，不指向 `package`、也不指向 `release_repository_record`：
  留痕是复盘用的旁证，后来改名的包与被删掉的 CRP Release 不该让这行失效。
- 与 4.13 的分工：快照记「每一轮固化了什么」，本表记「人为改了哪些轮、放弃了什么、重投了什么」。
  旧轮在快照表里标 `superseded` 并指向新轮，物理行永远保留；本表不参与快照状态流转。

### 4.22 build_poll_event（构建调度事件流水）

轮询这一轮做了什么（A14 追加）。设计契约 MUST 要求「调度事件流水记录：时间、软件包、事件、
触发条件、结果」，现有表都放不下：`crp_call_log` 记的是单个 CRP 请求，`sync_run` 记的是一整批同步，
`build_task` 只保留最新状态 —— 谁也说不清「什么时候、因为哪个条件、对哪个包做了什么」。

只追加、不改：写进去的行就是那一轮的事实。

| 字段（列名） | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | |
| `releaseId`（`release_id`） | text | NOT NULL | 所属提测 |
| `snapshotId`（`snapshot_id`） | text | NULL | 针对哪一轮快照；整条提测级别的事件（轮询、进度同步）为空 |
| `packageName`（`package_name`） | text | NULL | 软件包名，冗余存一份：快照可能被替换或清理，流水本身要能独立读懂 |
| `event` | text | NOT NULL | `poll`（轮询一轮）、`status`（某个包的状态变了）、`progress`（工作流进度回写） |
| `condition` | text | NOT NULL | 触发条件，例如「周期到期」「手动刷新」「轮询取到 Shuttle 的构建结论」 |
| `result` | text | NOT NULL | 结果，例如「查询 3 个包：成功 1、失败 0、构建中 2」；失败时是错误摘要 |
| `createdAt`（`created_at`） | timestamptz | NOT NULL | 记录时间 |

- 索引：`(release_id, created_at)`（按提测看流水）、`created_at`（队列页取最近若干条）。
- 外键：`release_id → release.id`，CASCADE。流水属于提测，提测清理时一起走；
  队列页按工作区查流水正是靠这条外键做关联查询。
- 状态类事件只在状态**真的变了**时写：轮询是反复跑的，每次都写会把流水刷满，
  而这张表要回答的是「谁在什么时候从哪一步走到哪一步」。
- 种子数据不写这张表：它是运行时记录，由轮询产生，与 `crp_call_log`、`release_update_record` 同一处理。

## 五、关键约束（逐条对应设计契约）

| 约束 | 落在哪 |
| --- | --- |
| `Package.name` 唯一 | `package_name_key` |
| `Project(workspaceId, name)` 唯一 | `project_workspace_id_name_key` |
| `Baseline.crpBranchId` 唯一 | `baseline_crp_branch_id_key` |
| `Release(projectId, version)` 唯一 | `release_project_id_version_key` |
| 快照按轮次唯一 | `release_package_snapshot_release_id_package_name_attempt_key` |
| 快照有状态字段且允许流转 | `release_package_snapshot.status`（`snapshot_status`，默认 `pending`） |
| 快照业务字段创建后不可改 | 应用层约束：除 `status`、`status_changed_at`、`superseded_by_id`、`superseded_at` 外不提供更新入口 |
| 被替换的轮次保留、不物理删除 | `superseded_by_id`、`superseded_at`；外键全部 RESTRICT，无级联删除 |
| `Release.revision` 与 `crpWorkProgress` | `release.revision`（默认 1）、`release.crp_work_progress` |
| `BuildTask` 挂在快照上 | `build_task.snapshot_id`（唯一，指向 `release_package_snapshot`） |
| 时间统一 UTC | 所有时间列都是 `timestamptz` |
| 项目无业务类型字段、基线无分类字段 | `project`、`baseline` 均无此类列；归属只由 `workspace_id` 与 `project_manager_id` 决定 |
| 删项目不删历史提测记录 | `project.deleted_at` 软删 + `release.project_id` 外键 RESTRICT |
| 高频查询索引 | `release.status`、`release.created_at`、`build_task.release_id`（`release.project_id` 由唯一索引最左前缀覆盖） |
| 每次 CRP 调用都有请求记录 | `crp_call_log`（URL、耗时、状态码、响应摘要），记录点在请求层而不是调用点 |
| 阻断可解释 | `build_task.blocked_by_snapshot_id` 指向造成阻断的上游快照，`build_task.status_reason` 给人看 |
| 每次轮询都回写工作流进度 | `release.crp_work_progress`、`crp_work_progress_label`、`crp_work_progress_synced_at`；取不到时保留旧值，绝不写 0 |
| 活跃提测多于单轮上限时轮流轮到 | `release.last_polled_at`（为空的最先），单轮上限只限「这一轮处理几条」，不限「哪些提测永远不处理」 |
| 调度事件流水五列齐全 | `build_poll_event`（`created_at`、`package_name`、`event`、`condition`、`result`） |
| 会话令牌只存哈希、服务端可撤销 | `session.token_hash` 唯一（存 SHA-256，不存令牌本身）、`session.revoked_at` 非空即失效 |
| 不预留回退与复盘的表 | 只有 `release.rollback_of_id`、`release.code_source_release_id`、`release.risk_flag` 三个可空字段 |

## 六、外键与删除策略总表

| 子表.列 | 父表 | 可空 | onDelete | 理由 |
| --- | --- | --- | --- | --- |
| `session.user_id` | `app_user.id` | 否 | CASCADE | 会话只是登录凭证，账号没了就失去意义 |
| `membership.workspace_id` | `workspace.id` | 否 | RESTRICT | 工作区不物理删除 |
| `membership.user_id` | `app_user.id` | 否 | RESTRICT | 账号不物理删除，成员关系要留 |
| `project_manager.workspace_id` | `workspace.id` | 否 | RESTRICT | 同上 |
| `project_manager.user_id` | `app_user.id` | 是 | SET NULL | 账号注销后项目经理实体保留，只解除账号绑定 |
| `baseline_package_version.baseline_id` | `baseline.id` | 否 | CASCADE | 包版本清单属于基线自身，随基线一起清掉 |
| `project.workspace_id` | `workspace.id` | 否 | RESTRICT | 项目只软删 |
| `project.project_manager_id` | `project_manager.id` | 否 | RESTRICT | 先转移项目再换人 |
| `project.baseline_id` | `baseline.id` | 否 | RESTRICT | 有项目在用就不能删基线 |
| `project_software.project_id` | `project.id` | 否 | RESTRICT | 项目只软删，物理删除被拒绝 |
| `project_software.package_id` | `package.id` | 否 | RESTRICT | 清单在用就不能删包 |
| `package_dependency.package_id` / `upstream_package_id` | `package.id` | 否 | RESTRICT | 先清依赖再删包 |
| `release.project_id` | `project.id` | 否 | RESTRICT | 删项目不删历史提测记录 |
| `release.created_by_id` | `app_user.id` | 否 | RESTRICT | 发起人要一直查得到 |
| `release_package_snapshot.release_id` | `release.id` | 否 | RESTRICT | 提测记录只流转状态，不物理删除 |
| `release_package_snapshot.superseded_by_id` | `release_package_snapshot.id` | 是 | RESTRICT | 旧轮必须留着 |
| `release_repository_record.release_id` | `release.id` | 否 | RESTRICT | 同上 |
| `release_repository_record.snapshot_id` | `release_package_snapshot.id` | 否 | RESTRICT | CRP 侧删了 Release，本地记录照留 |
| `build_task.release_id` | `release.id` | 否 | RESTRICT | 构建历史是复盘依据 |
| `build_task.snapshot_id` | `release_package_snapshot.id` | 否 | RESTRICT | 任务挂在轮次上 |
| `build_job.build_task_id` | `build_task.id` | 否 | CASCADE | 作业没有独立含义，随任务删除 |
| `release_update_record.release_id` | `release.id` | 否 | RESTRICT | 提测记录不物理删除，留痕要一直查得到 |
| `release_update_record.operator_id` | `app_user.id` | 否 | RESTRICT | 要知道是谁改的，账号不物理删除 |
| `build_poll_event.release_id` | `release.id` | 否 | CASCADE | 流水属于提测，提测清理时一起走 |
| `webhook_endpoint.workspace_id` | `workspace.id` | 否 | RESTRICT | 端点不随工作区删除 |
| `webhook_delivery.endpoint_id` | `webhook_endpoint.id` | 否 | RESTRICT | 端点只停用，投递日志要留 |

补齐「删项目」的完整语义：项目写 `deleted_at` 之后，列表与下拉框默认过滤，但 `release.project_id` 仍然指向它，所以历史提测记录、快照、构建记录全部照旧可查。

## 七、种子数据

`prisma/seed.ts` 灌入一套可重复执行的数据（不写 `session`：会话是运行时数据，由登录动作产生）（重复执行靠业务唯一键 upsert，`sync_run` 与 `webhook_delivery` 两张日志表每次重建）。种子跑完会逐表核对记录数，不一致直接以非零退出码失败。

`pnpm db:reset` 是「清空数据库 → 重放迁移 → 跑种子」（`prisma migrate reset --force && prisma db seed`）。Prisma 7 的 `migrate reset` 本身不再调用种子，所以脚本里显式接上了 `db:seed`。

| 表 | 记录数 | 说明 |
| --- | --- | --- |
| `workspace` | 3 | 桌面核心组、系统应用组、安全组 |
| `app_user` | 5 | 1 位平台管理员 + 2 位项目经理 + 1 位开发者 + 1 位只读成员；`password_hash` 是占位串，不是可校验的哈希，这些账号只用于数据演示，不能登录；A6 交付后要能登录的账号走「注册」或平台管理员的「成员邀请」接口建，种子里的哈希不改成可校验的真哈希 |
| `membership` | 7 | 平台管理员不进 membership |
| `project_manager` | 3 | 其中刘洋没有平台账号，演示 `user_id` 为空 |
| `baseline` | 4 | `eagle-1071`、`eagle-1076`、`snipe-2500u1`、`snipe-2500u2` |
| `baseline_package_version` | 12 | 每个基线 3 条 |
| `package` | 12 | 桌面与系统工具常用软件包 |
| `package_dependency` | 4 | 含一条三层依赖链：`deepin-polkit-agent → dde-session-shell → dde-dock` |
| `project` | 4 | 分布在三个工作区，各绑一个基线 |
| `project_software` | 15 | 各项目清单合计 |
| `release` | 5 | 含成功、失败、投递中、未提交、已放弃五种状态 |
| `release_package_snapshot` | 15 | 含 `kwin` 两轮：第 1 轮 `superseded` 指向第 2 轮 |
| `release_repository_record` | 8 | 已投递到 CRP 的轮次 |
| `build_task` | 7 | 已投递且已建立构建任务的轮次；`安全组件 2.1.0` 的 polkit 刚发出，还没有构建任务 |
| `build_job` | 12 | 每个已开工的任务 2 个架构（`amd64`、`arm64`），25.0.2 的两个任务各 1 个 |
| `webhook_endpoint` | 2 | 一个启用、一个停用 |
| `webhook_delivery` | 3 | 成功、失败重试三次、待投递各一条 |
| `sync_run` | 4 | 三次成功、一次失败 |

每条提测的状态、它下面各轮快照的状态、仓库记录与构建任务三处必须一致：提测整体成功的，快照、仓库记录、构建任务与作业都是 `success`；快照停在 `pending` 的，就是还没投递，也没有仓库记录与构建任务。

种子刻意保留两处可读的状态：
- `桌面专业版 V25 / 25.0.1`：整体成功。`kwin` 提了两轮，第 1 轮状态 `superseded`，`superseded_by_id` 指向第 2 轮；其余四个包各一轮，全部 `success` 且有对应仓库记录与构建任务。
- `桌面专业版 V25 / 25.0.2`：上游 `dde-file-manager` 构建失败，下游 `dde-dock` 停在 `pending`，从未投递（因而没有仓库记录与构建任务）。

## 八、与 PRD 初稿的差异与决定记录

### 8.1 CrpTopic 并入 release（不单独建表）

PRD 写的是 `Release 1-1 CrpTopic`。本版不建 `crp_topic` 表，Topic 的字段直接放在 `release` 上（`crp_topic_id`、`crp_branch_id`、`crp_topic_state`、`crp_topic_abandoned`、`crp_topic_completed`、`crp_work_progress` 系列）。理由：

- 关系严格一对一，独立表只会多一次 join，没有任何字段可以脱离 Release 独立存在。
- 任务书要求的表清单里没有 `CrpTopic`，且有 `Release.crpWorkProgress` 这条 MUST。
- 判读「还能不能改包」需要和提测记录一起读，放同一条记录上更直接。

### 8.2 新增 sync_run

任务书的表清单包含 `SyncRun`，PRD 没有。用途是给 PRD 6.4 的四类同步留下可查的执行记录（成功、失败、条数、耗时），否则定时任务出问题只有日志可查。只记过程，不存业务数据。

### 8.3 删除 A1 的示例模型 HealthCheck

A1 建 `health_check` 表只为验证迁移链路。A5 定稿 schema 后该表没有业务用途，迁移里 `DROP TABLE "health_check"` 一并删除，种子不再写入它。

### 8.4 保留 project.key

PRD 6.1 的建项目字段里有「标识」，所以保留 `key`，并加 `(workspace_id, key)` 唯一；任务书 MUST 要求的 `(workspace_id, name)` 唯一同时存在。

### 8.5 依赖环由应用层检测

`package_dependency` 只加唯一约束，不加「上下游不同」的 CHECK 约束。原因：Prisma 无法在 schema 里声明 CHECK，写在迁移文件里的约束会在后续 `migrate dev` 生成差异时被当作「schema 里没有的对象」处理掉，留下隐患。自依赖与环检测统一由应用层在保存时做（A7 节点）。

### 8.6 baseline_package_version 不指向 package

`baseline_package_version.package_name` 与 `package.name` 同名同义，但不建外键：基线仓库里有大量平台尚未登记的软件包（实测 124 / 488 个），强制外键会让同步失败。需要关联时按名字查。

### 8.7 主键选 UUID v7

A1 初稿把主键方案留给 A5。选 UUID v7：不暴露递增数量、可按时间排序、插入局部性接近自增整数；字符串类型让「外部系统给的 ID」（CRP/Shuttle 的数字 ID）与内部 ID 在类型上一致，避免两套主键。

### 8.8 冗余 release_id 的处理

`release_repository_record`、`build_task` 同时存 `release_id` 与 `snapshot_id`。`snapshot_id` 是权威归属（唯一约束落在它上面），`release_id` 是为按提测查询冗余出来的列。理由：构建队列页与详情页都按提测分页查询，走 `release_id` 索引比每次 join 快照表便宜；而轮次一旦写入就不会改换提测，冗余不会失同步。

## 九、v2 预留字段

`release` 上三个可空字段，本版只建列、不建外键、不写流程：

| 字段 | 含义 |
| --- | --- |
| `rollback_of_id` | 被回退的那次提测 ID |
| `code_source_release_id` | 代码来源提测 ID（同一份代码复用到另一次提测） |
| `risk_flag` | 是否标记为风险提测 |

本版不建任何回退、复盘、审批相关的表。
