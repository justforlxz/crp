# CRP 提测平台（Release Hub）

统信 CRP（crp.uniontech.com）之上的提测平台：补上项目化的提测归属、按软件依赖自动排队、可审计的提测快照。产品需求见 [docs/PRD.md](docs/PRD.md)，数据模型初稿见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)。

当前仓库已有项目骨架与账号体系：能安装、能迁移、能灌种子、能跑检查与测试。页面有登录、注册、工作台、
软件包（`/packages`）、Webhook 端点（`/webhooks`）、基线（`/baselines`）与构建队列（`/queue`）；
外部系统（CRP、Gerrit、Shuttle）的客户端只被对应的领域模块与 Route Handler 调用。

## 界面规范

改界面前先读 [`.agents/spec/design/design.md`](.agents/spec/design/design.md)，可交互原型是 [`.agents/spec/design/prototype.html`](.agents/spec/design/prototype.html)（单文件，双击即开）。

两份文件是界面的唯一基准：颜色、布局、组件、页面结构全部写成可核对的数字。**任何 UI 讨论先改原型，涉及 UI 的 PR 必须经 lxz 确认才能合并。**

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `22.x`：CI 与 `package.json` 的 `engines.node` 固定同一条版本线，本地验证于 22.23.2 |
| pnpm | 9（`corepack enable` 后自动取 `package.json` 里的 `packageManager`） |
| PostgreSQL | 14 或更高，需要一个可建库的账号 |

## 本机启动

1. 安装依赖。`postinstall` 会顺带执行 `prisma generate`，生成 Prisma Client 到 `generated/prisma/`（该目录不入库）。

   ```bash
   pnpm install
   ```

2. 把示例环境变量复制成自己的配置，按需改数据库连接串。

   ```bash
   cp .env.example .env
   ```

3. 准备一个空数据库。任选一种方式：

   - 已有 PostgreSQL：`createdb crp`，再把 `.env` 里的账号、密码、端口改成自己的
   - Docker：下面的命令创建的用户名、密码、库名与 `.env.example` 的默认值一致

     ```bash
     docker run -d --name crp-pg \
       -e POSTGRES_USER=crp -e POSTGRES_PASSWORD=crp -e POSTGRES_DB=crp \
       -p 5432:5432 postgres:17-alpine
     ```

4. 建表并灌入种子数据。

   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

5. 启动开发服务器，浏览器打开 <http://localhost:3000>。

   ```bash
   pnpm dev
   ```

6. 需要图形化看表时启动 Prisma Studio（默认 <http://localhost:5555>）。

   ```bash
   pnpm db:studio
   ```

## 切换分支后必须重新生成 Prisma 客户端

`generated/prisma` 是按 `prisma/schema.prisma` 生成的产物，不入库。切换分支或拉入新提交后，如果新提交改过 schema，本地这份客户端就已经过期。

所以切分支后先跑：

```bash
pnpm exec prisma generate
```

再跑 `pnpm typecheck` 或 `pnpm build`。

**典型症状**：构建报类型错误，说某个枚举值不存在或某个字段不存在，例如

```
lib/releases/abandon.ts(209,9): error TS2322: Type '"abandon_topic"' is not assignable to type 'ReleaseUpdateAction'.
```

而这段代码在 `main` 上明明存在。这时先跑一次 `pnpm exec prisma generate`，不要先怀疑主线代码。新增枚举值（例如 `ReleaseUpdateAction.abandon_topic`）时最容易撞上。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` / `pnpm start` | 生产构建 / 启动生产服务 |
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `pnpm test` | 单元测试（Node 内置测试运行器，经 tsx 执行 TypeScript）。分两组跑：会读到全库在跑提测的三个文件（`baseline-sync`、`build-dispatch`、`build-poll`，它们调用的定时任务是跨工作区挑活的）一次只跑一个；其余文件 4 个并行，靠各自的数据区间隔开（工作区前缀、假 CRP 的 Topic / Release ID 区间起点，两段重叠会让唯一约束凭空失败）。新增用例时：碰全库的函数只能加进第一组，其余用例只管自己的数据 |
| `pnpm db:migrate` | 应用已提交的迁移（`prisma migrate deploy`），空库建表用它 |
| `pnpm db:migrate:dev` | 开发时新建迁移（`prisma migrate dev --name <名称>`） |
| `pnpm db:reset` | 清空数据库、重放全部迁移并跑种子（`prisma migrate reset --force && prisma db seed`）；Prisma 7 的 reset 不再自动跑种子，所以这里显式接上；会丢数据，只对本地开发库用 |
| `pnpm db:seed` | 执行 `prisma/seed.ts` 写入种子数据，使用 upsert，可重复执行 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm tsx scripts/verify-baseline-sync.ts` | 用真实 CRP 与 Shuttle 跑一次基线同步，打印分支条数对照、`eagle-1071` 里 `kwin` 的版本对照与本次请求明细，会写库 |
| `pnpm tsx scripts/verify-gerrit.ts` | 用真实 Gerrit 复核分支、提交与 `debian/changelog` 读取，需要先配好 `GERRIT_*` 三项 |
| `pnpm tsx scripts/verify-projects.ts` | 用真实数据库验收项目经理与项目：归属校验、共用基线、复制不带提交历史、软删后提测记录仍可查；只动自己建的临时行 |
| `pnpm tsx scripts/verify-webhook.ts` | 本机起一个 Webhook 接收端点，验收投递、签名与重试，约 15 秒 |
| `pnpm tsx scripts/verify-webhook-signature.ts` | 独立复算某次投递的签名，参数见 `docs/WEBHOOK.md` |
| `pnpm tsx scripts/verify-base-url.ts --base-url=http://127.0.0.1:3000` | 从 base URL 打开：不带会话落到 `/login?next=%2Fdashboard`、带会话落到 `/dashboard`，且没有占位页原文。需要跑起来的服务与 `pnpm db:seed` 过的库，几秒；`scripts/e2e.sh` 的第 0 步就是它 |
| `scripts/style-check/container.sh` | 在门禁镜像里跑样式回归检查（L1 静态结构 + L2 计算样式 + L3 几何与整页截图）；加 `--update` 重写基线。判定口径见 [docs/STYLE-VERIFICATION.md](docs/STYLE-VERIFICATION.md) |

## 账号与登录

页面：`/login`、`/register`、`/dashboard`（未登录会跳登录页）。接口：注册、登录、退出、当前会话、工作区清单、
切换工作区、工作区项目清单、成员邀请，逐个见 [lib/auth/README.md](lib/auth/README.md)。

种子里的 5 个账号**不能登录**（`password_hash` 只是占位串，见 `docs/DATA_MODEL.md` 第七节）。要登录：

1. 打开 <http://localhost:3000/register> 注册一个账号；
2. 需要平台管理员时，把该账号的 `app_user.is_platform_admin` 置为 `true`；
3. 平台管理员可以在工作台直接把邮箱分配到某个工作区与角色，邮箱没有账号时顺带建号。

会话是服务端可撤销的 httpOnly Cookie（7 天、滑动续期），令牌只以 SHA-256 入库；角色判定全部在服务端，
`requireRole()` 供后续节点复用，不要另写一套。

## 基线同步与定时任务

基线就是 CRP 的一条交付分支。`/baselines` 页面展示全部基线与它们的软件包版本同步状态，
数据由同步任务写入，页面自己不拉外部接口。

一次同步做两件事，分别记各自的 `sync_run`：

| 动作 | 数据来源 | 请求数 |
| --- | --- | --- |
| 分支列表落库，标记消失的分支 | CRP `GET /branches`（**不需要认证**） | 固定 1 次 |
| 每个基线缓存软件包版本 | Shuttle 仓库信息 + apt 源码索引 | 每个基线 2 次 |

**为什么不刷全部 108 条分支**：每条基线 2 次请求，全量就是 216 次；软件包版本只在项目选了这条基线时
才有用，所以定时任务只刷新「被项目选中、且缓存已过期（默认 1 小时）」的基线。版本一次取回整条基线的
全部源码包（实测 `eagle-1071` 124 个、`snipe-2500u2` 488 个），不逐包查询。

**手动刷新**：`/baselines` 页面的「立即同步」按钮，需要登录；强制重拉被项目选中基线的版本，不看缓存是否过期。

**定时刷新**：外部定时器每小时 POST 一次接口，本仓库不引入队列或常驻调度进程。

```bash
# cron
0 * * * * curl -fsS -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN" \
  http://localhost:3000/api/jobs/baseline-sync

# systemd timer（/etc/systemd/system/baseline-sync.service + .timer）
# [Service]
# ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer <token>" \
#   http://localhost:3000/api/jobs/baseline-sync
# [Timer]
# OnCalendar=hourly
```

**失败时的行为**：同步失败只写本次 `sync_run`（状态、结束时间、错误摘要），`baseline` 与
`baseline_package_version` 一行不改，`syncedAt` 不前移 —— 失败的同步绝不会看起来像同步过。
页面状态列据「最近一次同步的结果」显示「同步失败」，并带上原因；历史数据继续可用。

## 投递与构建（提测执行）

提测创建完不会自己发出去：平台按依赖顺序逐个向 CRP 投递，上游构建成功才发下游。
推进逻辑全部在 `lib/build/`，入口是 `advanceRelease(releaseId)` —— **一次只往前走一步**，
进度只存在数据库里，所以进程重启不丢进度，重复触发也不会重复建 Topic。

| 步骤 | 做什么 |
| --- | --- |
| 1 | 还没有 Topic 就在项目选中的基线上建一个，把 Topic ID 写回提测记录 |
| 2 | 轮询已投递包的构建结果（CRP 取 `BuildID`，再按它问 Shuttle），写回构建任务与作业 |
| 3 | 有包构建失败 → 把它的全部下游标成阻断并写明「因上游 X 失败而阻断」，提测判失败 |
| 4 | 否则投递**一个**上游已全部成功的包（串行，不并发投递依赖链） |
| 5 | 全部成功 → `success`；有成功也有失败 → `partial_failure`；一个都没成功 → `failed` |

**定时推进**：外部定时器每隔几分钟 POST 一次接口，把在跑的提测各往前推一步。
本仓库不引入队列，也不依赖进程内定时器。

```bash
# cron：每 2 分钟推一次
*/2 * * * * curl -fsS -X POST -H "Authorization: Bearer $BUILD_DISPATCH_JOB_TOKEN" \
  http://localhost:3000/api/jobs/build-dispatch
```

页面上或接口里的手动动作（`POST /api/releases/{id}/dispatch`，可用 `?action=retry|cancel`）走的是同一个
`advanceRelease`，没有第二份推进逻辑。

## 构建队列与状态轮询

页面：`/queue`（构建队列）。回答三个问题：哪些包还在排队、各自卡在哪个上游、这一轮调度做了什么。

页面是**只读**的：状态由服务端定时轮询写进库，页面不自己调 CRP / Shuttle，也不用前端轮询去驱动写入。
提测按创建时间从新到旧列出，刚投递的排在最前；只列未完结的提测，所以不设条数上限
（加了上限会把最新投递的挤掉——这个坑在功能检测里踩过一次）。

数据全在 `lib/build/`：

| 能力 | 入口 |
| --- | --- |
| 轮询一轮（构建结果 + 工作流进度 + 事件流水） | `runBuildPoll({ trigger })` |
| 队列页与详情区块的只读数据 | `loadBuildQueue(workspaceId)`、`loadReleaseBuildStatus(releaseId)` |
| 调度事件流水 | `recordPollEvent()`、`listPollEvents(workspaceId)` |
| 提测详情页的只读区块组件 | `components/build-status.tsx` 的 `BuildStatusBlock` |

**定时轮询**：外部定时器每隔几分钟 POST 一次接口。已完结的提测（`success`、`partial_failure`、
`failed`、`abandoned`）自动不再轮询，一条请求都不发。单轮最多处理 50 条，挑活按
`release.lastPolledAt` 从旧到新（为空的最先），活跃提测更多时各条轮流轮到，最新投递的下一轮就会被轮到。

```bash
# cron：每 5 分钟轮询一次
*/5 * * * * curl -fsS -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN" \
  http://localhost:3000/api/jobs/build-poll
```

**手动轮询**：`/queue` 页面的「立即轮询」按钮，走的是同一个 `runBuildPoll()`。

两条边界不靠约定、靠代码：

- 轮询失败（Shuttle 超时、CRP 认证失败）**不改任何状态**，只记一条同步错误：查不到不等于构建失败。
- 取不到 CRP 工作流进度时**保留上一次的值**并记同步错误，绝不写 0 —— `Release.crpWorkProgress` 是
  A17 判断「还能不能改包」的唯一依据，写 0 会让已转测的提测被误判成还能改。

调度事件流水落在 `build_poll_event`：时间、软件包、事件、触发条件、结果五列，队列页按工作区展示最近 30 条。

## 项目与项目经理

页面：`/projects`（项目卡片列表）、`/projects/new`（新建）、`/projects/[id]`（详情、清单、复制、删除）、
`/managers`（项目经理清单与改名）。都要求登录，写操作要工作区里的「项目经理」角色，判定走 `lib/auth/server.ts`
的 `requireRole()`。页面按 `?workspace=<slug>` 选工作区，不带就用会话里记住的那个。

规则都落在 `lib/projects/service.ts`，页面与后续接口共用同一份：

- 项目必须指定一位项目经理，且这位项目经理属于项目所在工作区；项目经理绑定了平台账号时，该账号还得是这个工作区的成员。
- 项目必须绑一个状态为「已同步」的 CRP 基线。可用性直接复用 A9 的 `baselineState()`：
  「已消失」「最近一次同步失败」「未同步」三种状态在页面上不可选，保存时也被同一条规则拒绝，
  判定写在 `lib/projects/baselineGate.ts`。基线怎么选不限类型，两个项目也可以指向同一个基线。
- 项目名称与项目标识在工作区内唯一；项目标识小写字母、数字与连字符，用于网址与外部引用。
- 复制项目带走软件清单与每项的跟踪分支，`last_submitted_commit` / `last_submitted_at` 一律清空；名称、标识、项目经理、基线都可以改。
- 删除项目只写 `deleted_at`：列表与下拉框不再出现，但历史提测记录、快照与构建记录仍然指向它，照常可查。
- 项目卡片上的投递顺序由清单内部的依赖边算出（`sortByDependencies`，上游在前），出现依赖环时给出回路，不给出可用的顺序。
- 按项目 id 直接访问详情时，账号必须有当前工作区、且项目就在那个工作区，否则与「项目不存在」同一个 404；已删除的项目只给平台管理员翻看。这条判定写在 `lib/projects/access.ts` 的 `canViewProject` 里，由单测固定。
## 创建提测

页面：`/releases/new`，三步向导。接口：`POST /api/releases`，细节见 [docs/API.md](docs/API.md)。

| 步骤 | 做什么 |
| --- | --- |
| 第一步 项目归属 | 选项目经理 → 选其名下项目；展示目标仓库（CRP 基线）、基线同步状态、软件数；填 Topic 版本号与提测说明 |
| 第二步 检查仓库更新 | 点「从 Gerrit 刷新」拉每个包跟踪分支的最新提交；每个包可切分支、切历史 Commit；读 `debian/changelog` 得代码版本；从基线缓存取仓库版本；按依赖拓扑排序给出投递顺序；显示「有更新 / 无变化」；可填自定义 Tag |
| 第三步 确认 | 汇总表 + 提交 |

规则都落在 `lib/releases/`，页面与接口共用同一份：

- **阻断条件**（无软件清单、依赖有环、基线未同步）由 `lib/releases/plan.ts` 的 `evaluateReleaseReadiness()` 判定。
  页面用它禁用提交按钮，`POST /api/releases` 用它再拦一次 —— 只靠前端禁用不算数，直接调接口同样被拒。
- **清单内全部软件都进提测**，不因「无变化」排除；提交的软件包必须与项目清单完全一致（不多、不少、不重复）。
- **依赖排序只考虑清单内部的边**，不自动扩展清单外的依赖（复用 `sortByDependencies`）。
- **三个版本号**：代码版本来自所选 Commit 的 `debian/changelog`；仓库版本来自基线缓存
  （`getBaselineVersion`）；提测版本 = 自定义 Tag（填了的话）否则代码版本。自定义 Tag 只有一个字段，
  设置了它提测版本就是它本身，代码版本不受影响。格式规则来自 A2 实测的四条 CRP 限制
  （`lib/integrations/crp/tag.ts`），不符合当场拒绝并说明规则，不等到 A12 投递时才在 CRP 侧报错。
- **代码版本由服务端现读**，不采信请求体：快照是审计记录，客户端传什么就存什么等于把审计结论交给调用方。
- **快照只插入**，本节点不提供任何更新入口；补包换包走 A17 的追加轮次。创建后改项目配置，
  历史快照一行不变。
- 创建成功后把每个软件包的 `last_submitted_commit` / `last_submitted_at` 更新为本次 Commit，
  并发一条 `release.created` 事件（`emitEvent`）。提测状态是 `pending`（已创建、尚未投递），
  枚举里没有 `queued`。


## 持续集成

`.github/workflows/ci.yml` 在 `push` 到 `main` 与向 `main` 提 PR 时触发，两个 job：

**`checks`**（功能）：`pnpm install --frozen-lockfile` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm db:reset`（连续两次） → `pnpm lint` → `pnpm typecheck` → `pnpm test`

**`style`**（样式门禁）：跑在 `mcr.microsoft.com/playwright:v1.65.1-noble` 里 —— 与基线生成用的是同一个镜像，浏览器和字体都随镜像固定，不需要另外下载或缓存；步骤是 `pnpm install` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm test:style`。样式改坏时这个 job 失败、PR 标红；`--update` 在 CI 里被脚本拒绝。

- `checks` 的 Node 用 `22.x`，与 `package.json` 的 `engines.node` 同一条版本线；pnpm 的版本由 `package.json` 的 `packageManager` 决定（当前 `pnpm@9.15.9`），由 `pnpm/action-setup` 安装，不在 workflow 里重复写版本。
- `style` job 在容器里跑，Node 来自镜像，pnpm 由 job 按 `package.json` 的 `packageManager` 装上（版本只有这一个来源）；容器用 `--network` 默认桥接，靠 service 名 `postgres` 连库。
- 数据库用 `postgres:17` 的 service container，账号、库名、`DATABASE_URL` 都写在 workflow 里，不需要任何 secret。
- 迁移和种子在 CI 里真跑：`_prisma_migrations` 能建表、种子能写入，才说明「空库可迁移」这条在干净环境成立。
- `pnpm db:reset` 连跑两次：证明清库、重放迁移、灌种子这一整套可以重复执行，且每张表记录数仍与种子声明一致。这条会清空数据库，只允许放在一次性环境里跑。

## 样式门禁（`pnpm test:style`）

样式改坏了要能被机器挡住，而不是靠人看。判定方案完整版见 [docs/STYLE-VERIFICATION.md](docs/STYLE-VERIFICATION.md)，这里只放执行入口与三条要点。

三层检查，任意一层失败都以退出码 1 结束：

| 层 | 查什么 | 判据 |
| --- | --- | --- |
| L1 静态结构 | 页面是否都经 `PageShell` 渲染、有没有裸 `<table>`、有没有新增内联 `style`、`app/globals.css` 的规则数与设计变量 | 前三条命中 0 处；规则数不低于基线；变量值与基线一致 |
| L2 计算样式 | 6 个页面上 `data-style-anchor` 锚点的 14 个属性（字号、颜色、边框、圆角、内外边距、宽高等） | 与 `tests/visual/baseline/<页面>.json` 逐字段严格相等 |
| L3 几何与截图 | 锚点 `boundingBox` 与 1280×900 整页截图 | 几何 ≤ 2px；像素差 ≤ 0.5%，超阈值把差异图写到 `tests/visual/diff/` |

```bash
scripts/style-check/container.sh            # 比对（门禁镜像里跑）
scripts/style-check/container.sh --update   # 重写基线，只能人显式发起
```

三条要点：

- **必须进门禁镜像**（`mcr.microsoft.com/playwright:v1.65.1-noble`）：截图与几何对字体敏感，基线与 CI 都在这个镜像里。本机其它系统直接跑会报字体差异，那不是样式坏了。
- **`--update` 在 CI 里被拒绝**（退出码 2）。基线更新必须与引发它的样式改动在同一个 PR，Reviewer 要看基线 diff。
- **基线一次刷新全部**：六页的 JSON + PNG 加 `lint.json` 的规则数与设计变量，不允许只更新一部分；L1 结构检查没通过时一个也不写。

## 环境变量

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串，Prisma CLI 与应用运行共用。格式 `postgresql://<用户>:<密码>@<主机>:<端口>/<库名>?schema=public` |
| `GERRIT_BASE_URL` | 否 | Gerrit 服务地址，默认 `https://gerrit.uniontech.com` |
| `GERRIT_USERNAME` | Gerrit 集成必需 | Gerrit 用户名 |
| `GERRIT_HTTP_PASSWORD` | Gerrit 集成必需 | Gerrit HTTP 凭据密码，在 Gerrit 网页 Settings → HTTP Credentials 生成 |
| `CRP_USERNAME` | 用 CRP 写接口时必需 | CRP 登录用的 LDAP 账号 |
| `CRP_PASSWORD` | 用 CRP 写接口时必需 | 上述账号的 LDAP 密码；登录前用 CRP 的公钥加密，不落盘 |
| `CRP_BASE_URL` | 否 | CRP 接口前缀，默认 `https://crp.uniontech.com/api` |
| `CRP_TOKEN_PATH` | 否 | CRP token 缓存文件，默认 `~/.cache/crp/jwt`，权限 0600 |
| `PACKAGE_API_TOKEN` | 用 `POST /api/packages` 时必需 | 外部系统提交软件包用的独立 token，与用户会话无关；没配置时该接口一律返回 401。接口细节见 [docs/API.md](docs/API.md) |
| `SYNC_JOB_TOKEN` | 用 `POST /api/jobs/baseline-sync` 时必需 | 定时任务触发基线同步用的独立 token，与用户会话、`PACKAGE_API_TOKEN` 都无关；没配置时该接口一律返回 401 |
| `BUILD_DISPATCH_JOB_TOKEN` | 用 `POST /api/jobs/build-dispatch` 时必需 | 定时任务推进提测投递用的独立 token；这个接口会真的向 CRP 建 Topic、发 Release，没配置时一律返回 401 |
| `BUILD_POLL_JOB_TOKEN` | 用 `POST /api/jobs/build-poll` 时必需 | 定时任务轮询构建状态与 CRP 工作流进度用的独立 token；没配置时该接口一律返回 401 |
| `SHUTTLE_BASE_URL` | 否 | Shuttle 接口前缀，默认 `https://shuttle.uniontech.com/api/shuttle`；基线软件包版本从它读 |
| `CRP_BASE_URL` | 否 | CRP 接口前缀，默认 `https://crp.uniontech.com/api`；基线分支列表从它读，**不需要认证** |
| `SESSION_COOKIE_SECURE` | 否 | 会话 Cookie 的 `Secure` 属性，`true` / `false` 显式覆盖，不填按请求协议判断（`x-forwarded-proto` → 请求 URL 协议）。**走 http 的部署（内网、LAN、没有 TLS）设成 `false`**，否则浏览器直接丢弃 Cookie、登录后立刻弹回登录页；https 部署不要设成 `false`，否则会话明文传输 |

Gerrit 这三项只被 `lib/integrations/gerrit/` 读取，未配置时该模块抛错，其余功能不受影响。匿名访问会被 302 跳登录页，实测行为见 `lib/integrations/gerrit/FINDINGS.md`。

验证脚本 `scripts/verify-crp.ts` 另需 `CRP_VERIFY_PROJECT`、`CRP_VERIFY_PROJECT_BRANCH`、`CRP_VERIFY_COMMIT`，
说明见 `.env.example` 与 `lib/integrations/crp/FINDINGS.md`。

`.env` 已被 `.gitignore` 忽略，仓库里不出现任何真实凭据；新增变量时同步更新 `.env.example` 与本节表格。

## 目录结构

```
app/                 Next.js App Router：页面与将来的 Route Handler
lib/                 领域逻辑
lib/db.ts            Prisma Client 单例（带 pg 驱动适配器）
lib/auth/            账号、会话与角色守卫（说明见其 README）
lib/env.ts           环境变量读取与校验
lib/integrations/    CRP、Shuttle、Gerrit 客户端（职责边界见其 README）
lib/integrations/gerrit/  Gerrit 与 gitiles 客户端、changelog 解析、实测记录 FINDINGS.md
lib/webhook/         Webhook 事件清单、签名、投递与端点读写（约定见 docs/WEBHOOK.md）
lib/baselines/       基线读取：列表、同步记录、给其它节点用的版本查询（状态判定见 status.ts）
lib/build/           投递与构建：依赖链推进、CRP 投递、构建轮询回写、调用记录、队列读模型（入口见 index.ts）
lib/jobs/            定时任务的服务端逻辑：baseline-sync.ts（基线同步）、build-dispatch.ts（推进投递）、build-poll.ts（轮询鉴权）
components/          跨页面复用的服务端组件：build-status.tsx（提测详情页的构建状态区块）
lib/projects/        项目经理与项目：输入校验、清单排序、读写与业务规则
lib/releases/        创建提测：阻断条件、快照组装、输入校验与写库（Gerrit 读取见 gerrit.ts）
scripts/             接真实外部系统的验证脚本，不经 CI 执行
scripts/style-check/ 样式门禁：L1 静态检查、L2/L3 取样与比对、`--update`、门禁镜像入口
prisma/              schema、migrations、seed
tests/               单元测试
tests/visual/baseline/  样式门禁的基线（每页一份计算样式 JSON + 一张整页截图）
docs/                PRD、数据模型与 Webhook 约定文档
generated/           `prisma generate` 产物，不入库
```

## 数据库约定

- 迁移文件入库：`prisma/migrations/` 中的 SQL 是建表唯一来源，空库靠 `pnpm db:migrate` 建表。
- 改 schema 后用 `pnpm db:migrate:dev --name <名称>` 生成新迁移，不要手改已提交的迁移。
- 本节点只放了一个示例模型 `HealthCheck` 验证链路，业务表在 A5 节点按 `docs/DATA_MODEL.md` 建模。
