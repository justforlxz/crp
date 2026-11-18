# 数据模型初稿

本文把 PRD 第五节的领域模型展开到表与字段，作为 A5 节点正式建模的输入。本节点不建业务表：`prisma/schema.prisma` 里只有一个示例模型 `HealthCheck`，用于验证迁移链路。

## 一、全局约定

| 项 | 约定 |
| --- | --- |
| 数据库 | PostgreSQL |
| 表名 | 单数 snake_case，Prisma 侧用 `@@map` 映射 |
| 主键 | `id`，UUID 字符串，应用侧生成 |
| 时间 | `timestamptz`，字段名后缀 `_at`；每表保留 `created_at`，可变的表加 `updated_at` |
| 外键 | `<实体>_id`，默认 `ON DELETE RESTRICT`；确需级联时在表下单独说明 |
| 枚举 | PostgreSQL 枚举类型，名称 `<表名>_<字段名>` |
| 账号表名 | `app_user`，避免与 SQL 关键字 `user` 冲突 |

## 二、关系总览

```
app_user 1-n membership n-1 workspace
workspace 1-n project_manager
project_manager 1-n project
project 1-1 baseline（外键 project.baseline_id）
project 1-n project_software n-1 package
package 1-n package_dependency（自关联，记录上游依赖）
baseline 1-n baseline_package_version（数据来自 Shuttle）
project 1-n release
release 1-1 crp_topic
release 1-n release_package_snapshot
release 1-n release_repository_record
release 1-n build_task 1-n build_job
webhook_endpoint 1-n webhook_delivery
```

## 三、枚举

| 枚举 | 取值 | 用途 |
| --- | --- | --- |
| `workspace_role` | `project_manager`、`developer`、`reader` | 工作区内成员角色；平台管理员是账号级标记，不占此枚举 |
| `project_type` | `mainline`（主线）、`commercial`（商业项目） | 项目类型 |
| `release_status` | `pending`、`submitting`、`succeeded`、`partially_failed`、`failed` | 提测状态 |
| `build_status` | `pending`、`running`、`succeeded`、`failed`、`canceled` | 构建任务与构建作业状态 |
| `webhook_delivery_status` | `pending`、`succeeded`、`failed` | Webhook 投递状态 |

## 四、表定义

### 4.1 app_user（账号）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `email` | text | NOT NULL, UNIQUE | 登录账号 |
| `password_hash` | text | NOT NULL | 只存哈希，不存明文 |
| `display_name` | text | NOT NULL | 显示名 |
| `is_platform_admin` | boolean | NOT NULL, 默认 false | 平台管理员标记，可访问全部工作区 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.2 workspace（工作区）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `slug` | text | NOT NULL, UNIQUE | 工作区标识，用于 URL |
| `name` | text | NOT NULL | 工作区名称 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.3 membership（工作区成员）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `workspace_id` | uuid | NOT NULL, FK → workspace | |
| `user_id` | uuid | NOT NULL, FK → app_user | |
| `role` | `workspace_role` | NOT NULL | 该用户在此工作区的角色 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

唯一约束：`(workspace_id, user_id)`。

### 4.4 project_manager（项目经理）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `workspace_id` | uuid | NOT NULL, FK → workspace | 项目经理归属一个工作区 |
| `user_id` | uuid | NULL, FK → app_user | 绑定的平台账号；未开通账号时为空 |
| `name` | text | NOT NULL | 展示用姓名 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.5 baseline（CRP 基线）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `crp_branch_id` | text | NOT NULL, UNIQUE | CRP `/branches` 返回的分支 ID |
| `name` | text | NOT NULL | 例如 `eagle-1071`、`snipe-2500u2` |
| `synced_at` | timestamptz | NULL | 最近一次同步成功时间，用于「基线未同步」阻断判断 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.6 package（软件包）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `name` | text | NOT NULL | 软件包名称 |
| `repo_path` | text | NOT NULL, UNIQUE | 仓库路径，例如 `deepin-kde/kwin`；全局唯一登记 |
| `default_branch` | text | NOT NULL | 默认跟踪分支，例如 `develop/eagle` |
| `current_version` | text | NULL | 登记时填写的当前版本 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.7 package_dependency（软件包上游依赖）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `package_id` | uuid | NOT NULL, FK → package | 下游包 |
| `upstream_package_id` | uuid | NOT NULL, FK → package | 上游包，必须先构建成功 |
| `created_at` | timestamptz | NOT NULL | |

唯一约束：`(package_id, upstream_package_id)`；检查约束：`package_id <> upstream_package_id`。依赖环由应用层在保存时检测，不靠数据库约束。

### 4.8 project（项目）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `workspace_id` | uuid | NOT NULL, FK → workspace | |
| `project_manager_id` | uuid | NOT NULL, FK → project_manager | 每个项目必须指定一位 |
| `baseline_id` | uuid | NOT NULL, FK → baseline | 单选，一个项目同一时间只有一个目标基线 |
| `key` | text | NOT NULL | 项目标识 |
| `name` | text | NOT NULL | 项目名称 |
| `type` | `project_type` | NOT NULL | 主线或商业项目 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

唯一约束：`(workspace_id, key)`。

### 4.9 project_software（项目软件清单）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `project_id` | uuid | NOT NULL, FK → project | |
| `package_id` | uuid | NOT NULL, FK → package | |
| `tracked_branch` | text | NOT NULL | 本项目默认跟踪分支，可覆盖软件包默认分支 |
| `last_submitted_commit` | text | NULL | 上次提测成功的 Commit；只在提测创建成功后更新 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

唯一约束：`(project_id, package_id)`。项目不重复存依赖，依赖只在 `package_dependency` 维护。

### 4.10 release（提测记录）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `project_id` | uuid | NOT NULL, FK → project | 提测归属项目 |
| `topic_version` | text | NOT NULL | 填写的 Topic 版本号 |
| `description` | text | NULL | 提测说明 |
| `status` | `release_status` | NOT NULL, 默认 `pending` | 提测状态 |
| `created_by` | uuid | NOT NULL, FK → app_user | 发起人 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

第二版预留（本版只留在文档里，不建字段）：`rollback_of_id`、`code_source_release_id`、`risk_flag`。

### 4.11 crp_topic（提测对应的 CRP Topic）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `release_id` | uuid | NOT NULL, UNIQUE, FK → release | 一条提测对应一个 Topic |
| `crp_topic_id` | text | NOT NULL, UNIQUE | CRP 返回的 Topic ID |
| `crp_branch_id` | text | NOT NULL | 建 Topic 时使用的基线分支 ID |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.12 release_package_snapshot（提测快照）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `release_id` | uuid | NOT NULL, FK → release | |
| `package_id` | uuid | NOT NULL, FK → package | |
| `branch` | text | NOT NULL | 固化的分支 |
| `commit_sha` | text | NOT NULL | 固化的 Commit |
| `code_version` | text | NOT NULL | 从 `debian/changelog` 解析的版本 |
| `repo_version` | text | NULL | 该基线仓库当前已有版本，来自 Shuttle，查不到时为空 |
| `release_version` | text | NOT NULL | 本次提交给 CRP 的版本（Tag） |
| `created_at` | timestamptz | NOT NULL | |

唯一约束：`(release_id, package_id)`。**创建后不可修改**：不提供更新字段的接口，修正只能新建一次提测。

### 4.13 release_repository_record（提测与 CRP 仓库记录的关联）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `release_id` | uuid | NOT NULL, FK → release | |
| `package_id` | uuid | NOT NULL, FK → package | |
| `crp_release_id` | text | NOT NULL, UNIQUE | CRP 侧 Release ID |
| `repository_url` | text | NULL | CRP `/topic_urls` 查到的仓库地址 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.14 build_task（构建任务）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `release_id` | uuid | NOT NULL, FK → release | |
| `package_id` | uuid | NOT NULL, FK → package | |
| `shuttle_task_id` | text | NULL, UNIQUE | Shuttle 侧任务 ID，尚未查询到时为空 |
| `status` | `build_status` | NOT NULL, 默认 `pending` | |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.15 build_job（构建作业）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `build_task_id` | uuid | NOT NULL, FK → build_task | |
| `shuttle_job_id` | text | NOT NULL, UNIQUE | Shuttle 侧 job ID，日志按它查询 |
| `status` | `build_status` | NOT NULL, 默认 `pending` | |
| `started_at` / `finished_at` | timestamptz | NULL | |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.16 webhook_endpoint（Webhook 端点）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `workspace_id` | uuid | NOT NULL, FK → workspace | |
| `url` | text | NOT NULL | 回调地址 |
| `secret` | text | NOT NULL | 签名密钥，来自环境变量或管理员录入，不进日志 |
| `event_types` | text[] | NOT NULL | 订阅的事件类型 |
| `enabled` | boolean | NOT NULL, 默认 true | |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

### 4.17 webhook_delivery（Webhook 投递记录）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `endpoint_id` | uuid | NOT NULL, FK → webhook_endpoint | |
| `event_type` | text | NOT NULL | 事件类型 |
| `payload` | jsonb | NOT NULL | 投递内容 |
| `signature` | text | NOT NULL | 本次签名，用于复算校验 |
| `status` | `webhook_delivery_status` | NOT NULL, 默认 `pending` | |
| `attempts` | integer | NOT NULL, 默认 0 | 已投递次数 |
| `last_error` | text | NULL | 最近一次失败原因 |
| `created_at` / `delivered_at` | timestamptz | `created_at` NOT NULL；`delivered_at` NULL | |

## 五、关键约束汇总

1. `package` 全局唯一，依赖只在 `package_dependency` 维护，项目清单不重复存依赖。
2. `release_package_snapshot` 创建后不可修改。
3. `project_software.last_submitted_commit` 只在提测创建成功后更新。
4. `project.baseline_id` 单选，一个项目同一时间只有一个目标基线。
5. `release` 与 `crp_topic` 一对一；`release` 与快照、仓库记录、构建任务一对多。

## 六、留给 A5 的决定

- 主键是否改用 `cuid` 或自增整数；本文按 UUID 描述。
- `baseline_package_version` 是并入本文档的独立表（字段：`baseline_id`、`repo_path`、`version`、`fetched_at`，唯一约束 `(baseline_id, repo_path)`），A5 需要确认它与 `package` 是否建立外键：CRP 基线里存在尚未登记的软件包，因此初稿按 `repo_path` 关联而不强制外键。
- 软删除策略：第一版统一物理删除，若需要审计再加 `deleted_at`。
