# CRP 提测平台（Release Hub）产品需求文档

版本：v1.0（2026-11-18）
状态：待评审
适用范围：第一版，不含回退与复盘

## 一、背景与目标

统信内部用 CRP（crp.uniontech.com）做代码仓库提测和版本管理。CRP 缺三样东西：

1. 不支持按软件依赖关系排队构建，每次都要人工判断先后顺序。
2. 不记录「项目」这一层：主线、商业项目各自的软件清单、基线、责任人散落在人脑里。
3. 提测时看到的分支、Commit、版本号，事后无法复盘。

本平台在 CRP 之上补这三层：项目化的提测归属、按依赖自动排队、可审计的提测快照。

**成功标准**：一条命令创建提测后，平台自动按依赖顺序向 CRP 投递全部软件包，中途失败会阻断下游并通知，全过程可在详情页查证。

## 二、术语

| 术语 | 定义 |
| --- | --- |
| 工作区 | 项目、提测记录、成员工件的隔离边界。用户可属于多个工作区。 |
| 项目经理 | 独立实体，归属于一个工作区。每个项目必须指定一位。 |
| 项目 | 一次提测的归属对象。分「主线」和「商业项目」两类。固定绑定一个 CRP 基线、一份软件清单。 |
| CRP 基线 | CRP 里的系统仓库版本，例如 `eagle-1071`、`snipe-2500u2`。来自 CRP 交付分支列表。 |
| 软件包 | 一个代码仓库，例如 `deepin-kde/kwin`。全局唯一登记，带默认分支和上游依赖。 |
| 项目软件清单 | 项目引用的软件包集合，每项记录默认跟踪分支和上次提交的 Commit。 |
| 代码版本 | 所选 Commit 里 `debian/changelog` 的最新版本号。 |
| 仓库版本 | 该软件包在目标 CRP 基线仓库里当前已有的版本。数据来自 Shuttle。 |
| 提测版本 | 本次提交给 CRP 的版本号（CRP 的 Tag）。默认等于代码版本，可用自定义 Tag 覆盖。 |
| 提测记录 | 一次提测。对应 CRP 的一个 Topic，内含每个软件包一条 Release。 |
| 提测快照 | 创建提测时固化的每个软件包的分支、Commit、代码版本、仓库版本、提测版本。 |

## 三、角色

| 角色 | 权限范围 |
| --- | --- |
| 平台管理员 | 全部工作区、成员、系统接入配置 |
| 项目经理 | 所负责项目的配置与提测 |
| 开发者 | 在工作区内创建提测、查看记录与构建状态 |
| 只读成员 | 只读 |

## 四、范围

### 第一版包含

1. 账号、登录、工作区、角色权限。
2. 软件包登记（手工填写 + POST 接口）、依赖配置与环检测。
3. CRP 基线同步、基线软件包版本查询。
4. 项目经理与项目的增删改查、项目复制、项目软件清单。
5. 创建提测三步流程、提测快照固化。
6. 向 CRP 创建 Topic、按依赖顺序逐个投递 Release、失败阻断。
7. 提测记录列表、提测详情、仓库记录关联、导出。
8. 构建状态轮询、构建队列页。
9. Webhook 通知（端点、事件订阅、签名、重试、投递日志）。
10. 工作台统计。

### 第一版不做

- 版本回退与紧急回退复盘（接口与数据模型预留，不做页面与流程）。
- 软件组（已从需求中删除）。
- CRP 软件包目录全量同步（CRP 没有列全部接口）。
- 向 CRP 推进转测 / 转发布工作流。
- 多语言、移动端。

## 五、领域模型

```
Workspace 1-n Membership n-1 User
Workspace 1-n ProjectManager
ProjectManager 1-n Project
Project 1-1 Baseline（外键）
Project 1-n ProjectSoftware n-1 Package
Package 1-n PackageDependency（自关联，记录上游依赖）
Baseline 1-n BaselinePackageVersion（来自 Shuttle）
Project 1-n Release
Release 1-1 CrpTopic
Release 1-n ReleasePackageSnapshot
Release 1-n ReleaseRepositoryRecord
Release 1-n BuildTask 1-n BuildJob
WebhookEndpoint 1-n WebhookDelivery
```

关键约束：

- `Package` 全局唯一，依赖只在 `PackageDependency` 上维护，项目不重复存依赖。
- `ReleasePackageSnapshot` 创建后不可修改。
- `ProjectSoftware.lastSubmittedCommit` 在提测创建成功后才更新。
- `Project.baselineId` 单选，一个项目同一时间只有一个目标基线。

## 六、核心流程

### 6.1 配置阶段

1. 管理员/项目经理创建项目经理。
2. 创建项目：名称、标识、类型、项目经理、工作区、CRP 基线。
3. 登记软件包：手工填写名称、仓库路径、默认分支、当前版本；或走 `POST /api/packages` 由外部系统提交。登记后配置上游依赖，保存时检测环。
4. 项目软件清单：从已登记软件包中添加，设置每项默认跟踪分支。复制项目时带走清单和默认分支，不带走提交历史。

### 6.2 创建提测

第一步 项目归属：选项目经理 → 选其名下项目。展示目标仓库、项目基线、基线同步状态、软件数。填 Topic 版本号、提测说明。

第二步 检查仓库更新：
- 点「从 Gerrit 刷新」拉取每个软件包所选分支的最新 Commit。
- 每个软件包可切分支、切历史 Commit。
- 从所选 Commit 的 `debian/changelog` 解析代码版本。
- 从 Shuttle 取该基线仓库的当前版本。
- 依赖拓扑排序得出提交顺序（仅清单内依赖）。
- 显示「有更新 / 无变化」，仅作提示，不影响是否纳入。

第三步 确认：汇总后提交。

阻断条件：项目无软件清单；依赖存在环；基线未同步。

### 6.3 提交与排队

1. 在目标基线上创建 CRP Topic。
2. 按拓扑顺序逐个调用 `new_release`；每个软件包一条 Release。
3. 上游构建成功才投下游；上游失败则阻断全部下游、提测状态置为失败、发通知。
4. 轮询 Shuttle 取构建任务与结果，写回提测状态。
5. 全部成功 → 提测成功；部分失败 → 部分失败。

### 6.4 同步边界

| 数据 | 触发 |
| --- | --- |
| 基线列表 | 定时刷新（每小时）+ 手动 |
| 基线内软件包版本 | 定时刷新（每小时）+ 手动 |
| 软件包元数据 | 定时刷新（每小时）+ 手动 |
| 创建提测时的分支与 Commit | 手动触发（Gerrit） |
| Topic 状态与构建结果 | 定时轮询 |
| 提测与 CRP 仓库记录的关联 | 手动刷新 |

## 七、外部接口契约

### 7.1 CRP（https://crp.uniontech.com/api）

| 用途 | 接口 |
| --- | --- |
| 登录 | `POST /login`，password RSA-PKCS1v15 加密后 base64 |
| 基线列表 | `GET /branches` |
| 建 Topic | `POST /branches/{branch_id}/topics` |
| 投递构建 | `POST /topics/{topic_id}/new_release` |
| 查 Release | `GET /topics/{topic_id}/releases` |
| 删 Release | `DELETE /topic_releases/{id}` |
| 重试 Release | `POST /topic_releases/{id}/retry` |
| 仓库地址 | `POST /topic_urls` |

版本号传递约定：默认用代码版本作为 `Tag`，并置 `ChangeLogMode=false`，保证提交版本与快照一致。该约定需在第一个集成任务里对真实接口验证，验证不成立则改为 `ChangeLogMode=true` 并记录差异。

### 7.2 Shuttle（https://shuttle.uniontech.com/api/shuttle）

| 用途 | 接口 |
| --- | --- |
| 基线仓库软件包版本 | 待探查确认（任务 A4 的第一项交付） |
| 构建任务列表 | `POST /task/list` |
| 构建日志 | `GET /job/log?jobid=` |

### 7.3 Gerrit

| 用途 | 接口 |
| --- | --- |
| 分支列表 | `GET /a/projects/{project}/branches/` |
| 提交列表 / 单条提交 | `GET /a/projects/{project}/commits`、`/commits/{sha}` |
| 读 `debian/changelog` | `GET /plugins/gitiles/{project}/+/{ref}/debian/changelog?format=TEXT`（base64） |

已确认 gitiles 插件可用。分支形如 `develop/eagle`，仓库路径形如 `deepin-kde/kwin`。

## 八、技术约定

| 项 | 约定 |
| --- | --- |
| 技术栈 | Next.js（App Router）+ TypeScript 全栈 |
| 数据库 | PostgreSQL |
| ORM | Prisma（含迁移与种子） |
| 认证 | 平台自建账号，邮箱 + password，httpOnly Cookie 会话 |
| 定时任务 | 进程内调度器，与 Web 服务同进程，可单实例运行 |
| 密钥管理 | 全部走环境变量，不入库明文 |

## 九、验收总纲

第一版合入前必须同时成立：

1. 全链路：配置项目 → 创建提测 → 真实向 CRP 建 Topic 与投递 Release → 构建结果回写 → 详情页可查证。
2. 依赖排队：人为让上游失败，下游不得投递，提测状态为失败，Webhook 收到失败事件。
3. 快照不变性：提测创建后改分支或提交，历史详情不变。
4. 权限：只读成员调用写接口返回 403。
5. 定时任务：基线与基线版本按周期刷新，日志可查。

## 十、后续演进

第二版：版本回退与紧急回退复盘。数据模型预留 `Release.rollbackOfId`、`Release.codeSourceReleaseId`、`Release.riskFlag`。

## 实现备注（A1）

- 本文档由任务附件原样提交，正文未改写。
- 第五节的数据模型已展开到 `docs/DATA_MODEL.md`，正式建模在 A5 节点完成。
- 第七节列出的 CRP、Shuttle、Gerrit 接口在 A2、A3、A4 节点接入，本节点不实现任何调用。
