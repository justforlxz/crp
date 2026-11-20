# 运行手册（RUNBOOK）

这份文档的目标只有一个：**另一个人拿到一台空机器，照这里一步步做，就能把平台跑起来并完成一次提测。**

文档里的命令都可以直接复制执行。涉及凭据的地方一律用环境变量，不要写进仓库。

---

## 一、它是什么，边界在哪

平台搭在统信 CRP（`crp.uniontech.com`）之上，补三件事：项目化的提测归属、按软件依赖自动排队、可审计的提测快照。

它**不**做的事（不要指望它）：

- 不做 CRP 的转测 / 转发布工作流，只在提测详情页展示 CRP 的 `WorkProgress`；
- 没有常驻调度进程、没有队列，所有定时推进靠外部定时器打 HTTP 接口（见第五节）；
- 不删除 CRP 的 Topic（CRP 没有这个接口），只能「放弃」（见第十一节）。

页面共 8 个：工作台、项目、项目经理、软件包、基线、提测记录、构建队列、Webhook。

---

## 二、环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `22.x` | `package.json` 的 `engines.node` 固定在这一条版本线；本地验证于 22.23.2 |
| pnpm | 9 | `corepack enable` 后自动取 `package.json` 里的 `packageManager`（9.15.9） |
| PostgreSQL | 14 或更高 | 需要一个能建库的账号；`prisma migrate` 会自己建表 |
| 出网 | CRP、Gerrit、Shuttle 三个内网域名 | 只读基线列表可以用匿名；投递 Release 必须用 LDAP 账号 |
| docker（可选） | 只在跑样式门禁时需要 | 门禁镜像 `mcr.microsoft.com/playwright:v1.65.1-noble` |

---

## 三、从零部署

### 3.1 取代码并安装依赖

```bash
git clone https://github.com/justforlxz/crp.git
cd crp
corepack enable
pnpm install          # postinstall 会执行 prisma generate
```

`prisma generate` 把 Prisma Client 生成到 `generated/prisma/`，该目录不入库。

### 3.2 准备数据库

任选一种。

已有 PostgreSQL：

```bash
createdb crp
```

Docker：

```bash
docker run -d --name crp-pg \
  -e POSTGRES_USER=crp -e POSTGRES_PASSWORD=crp -e POSTGRES_DB=crp \
  -p 5432:5432 postgres:17-alpine
```

### 3.3 配置环境变量

先把 `.env.example` 复制成 `.env`（`.env` 已被 `.gitignore` 忽略）：

```bash
cp .env.example .env
```

**必需**：

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串；Prisma CLI 与运行时共用 |
| `CRP_USERNAME` / `CRP_PASSWORD` | CRP 的 LDAP 账号；建 Topic、投递 Release、读工作流进度都要它 |
| `GERRIT_USERNAME` / `GERRIT_HTTP_PASSWORD` | Gerrit HTTP 凭据；读分支、提交与 `debian/changelog` 要它 |
| `PACKAGE_API_TOKEN` | `POST /api/packages` 的独立 token；不配则该接口一律 401 |
| `SYNC_JOB_TOKEN` | `POST /api/jobs/baseline-sync` 的独立 token |
| `BUILD_DISPATCH_JOB_TOKEN` | `POST /api/jobs/build-dispatch` 的独立 token |
| `BUILD_POLL_JOB_TOKEN` | `POST /api/jobs/build-poll` 的独立 token |

**可选**：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `CRP_BASE_URL` | `https://crp.uniontech.com/api` | CRP 接口前缀 |
| `CRP_TOKEN_PATH` | `~/.cache/crp/jwt` | CRP 的 JWT 缓存，按 `exp` 自动失效，写成 0600 |
| `GERRIT_BASE_URL` | `https://gerrit.uniontech.com` | Gerrit 地址 |
| `SHUTTLE_BASE_URL` | `https://shuttle.uniontech.com/api/shuttle` | Shuttle 地址 |
| `SHUTTLE_TOKEN` | 空 | 当前用到的三个读接口实测不校验身份，不填也能用 |

token 的生成方式：

```bash
openssl rand -hex 32     # 四个 token 各生成一份，不要复用
```

`.env` 里的值只给服务端读，不要在前端出现，也不要写进提交信息。

### 3.4 建表与灌数据

```bash
pnpm db:migrate     # prisma migrate deploy，可重复执行
```

接下来二选一：

- **演示 / 演练环境**：`pnpm db:seed`。会灌入 3 个工作区、4 个项目、12 个软件包、4 条基线、5 条提测记录与 2 个 Webhook 端点，并自带「连得上 CRP 的」基线分支 ID。
- **生产环境**：不要跑 seed（它会写入演示项目与提测记录）。按 3.6 手工初始化。

> **seed 里的账号不能登录**：5 个演示账号的 `password_hash` 是占位串，任何密码都过不了。
> 第一个能登录的账号要自己注册再提权，见 3.6 —— 种子环境也要走这一步，否则打开 `/dashboard`
> 只会看到「当前账号还没有加入任何工作区」。

> `pnpm db:reset`（`prisma migrate reset --force`）在 Prisma 7 上会要求人机确认，无人值守时会被拒。要退回干净种子库，等价做法是删库重建：
>
> ```bash
> psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
> pnpm db:migrate && pnpm db:seed
> ```

### 3.5 构建并启动

```bash
pnpm build
pnpm start            # 默认 3000 端口；改端口用 PORT=xxxx pnpm start
```

开发时用 `pnpm dev`。反代到公网时把 `Cookie` 的 Secure 属性交给 HTTPS 层，应用本身按环境变量决定是否加 `Secure`。

### 3.6 第一个能登录的账号（种子环境与生产环境都要做）

`pnpm db:seed` 灌进来的 5 个账号是演示数据，`password_hash` 是 `seed-not-a-real-hash-admin` 这类占位串，
**任何密码都登不进去** —— 这是故意的：不往仓库里放一个可用的管理员口令。所以不管跑没跑 seed，
第一个能登录的账号都要自己注册，再提成平台管理员：

1. 打开 `/register` 注册第一个账号。注册后会自动登录，但还不是管理员，`/dashboard` 显示
   「当前账号还没有加入任何工作区，请联系平台管理员分配」。
2. 把它提升为平台管理员（表名是 `app_user`，不是 `user`）：

```sql
UPDATE app_user SET is_platform_admin = true WHERE email = 'you@uniontech.com';
```

刷新 `/dashboard`：平台管理员能看到全部工作区。种子环境到这一步就会列出「安全组 / 桌面核心组 /
系统应用组」，点「切换到这里」进去就能看到该工作区的种子提测（桌面核心组 3 条；三个工作区合计 5 条：
安全组 1、桌面核心组 3、系统应用组 1）。

3. **生产环境（没跑 seed）还要建一个工作区**，种子环境跳过这一步：

```sql
INSERT INTO workspace (id, slug, name, created_at, updated_at)
VALUES (gen_random_uuid(), 'desktop-core', '桌面核心组', now(), now());
```

> 当前版本没有「创建工作区」的接口或页面，第一次初始化只能手工做。**这是一处已知的部署缺口**，见第十一节。

> **这一步会让库不再是纯种子数据**（种子里的账号数是被核对的），所以第七节的样式门禁要在这之前跑。
> 第十二节的顺序已经按这个约束排好（门禁第 2 步、注册第 3 步）；顺序反过来会看到
> 「库里的数据与种子声明不一致」并退出 2。

4. 用管理员账号登录，进入「工作台 → 邀请成员」把同事拉进工作区；工作区角色在成员接口里分配。
5. 手动触发一次基线同步，让 CRP 的交付分支进入平台：

```bash
curl -fsS -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN" \
  http://127.0.0.1:3000/api/jobs/baseline-sync
```

同步完成后「基线」页面会出现全部交付分支（实测 108 条）。

6. 到「基线」页面点一次「立即同步」（`trigger=manual, force=true`），把每个基线的软件包版本拉下来。

这一步不能省，而且是**先有鸡还是先有蛋**的地方：分支列表同步只写基线本身，`synced_at` 仍是空的，
基线状态是「从未同步」；而「从未同步」的基线**不能**被项目选中（创建项目会被拒），
定时同步又只刷新「已被项目选中」的基线。所以第一次必须点一次「立即同步」强制全量拉。

---

## 四、首次配置（页面顺序）

按下面的顺序做，每一步都依赖上一步的结果：

1. **项目经理**（`/managers`）：先建人，项目要指定一位项目经理。
2. **项目**（`/projects/new`）：名称、标识、项目经理、CRP 基线。项目标识会被用作 CRP Topic 名的前缀，例如标识 `kwin-project` + 版本 `1.0.0` → Topic 名 `kwin-project-1.0.0`。
3. **软件包**（`/packages` 或 `POST /api/packages`）：登记仓库路径、默认分支、当前版本。
4. **软件清单与依赖**：在项目详情页把软件包加进清单，设置每项跟踪分支；在软件包详情页配置上游依赖（保存时会做环检测，成环整次拒绝）。
5. **基线**（`/baselines`）：确认项目选中的基线「已同步」。未同步会让创建提测被 409 挡住。
6. **Webhook**（`/webhooks`，可选）：填端点地址与订阅事件，签名方式见 `docs/WEBHOOK.md`。

### 两个名字：`name` 与 `crpProjectName`

平台里一个软件包有两个名字，**它们不是一回事，必须分开填**：

| 字段 | 是什么 | 用在哪 | 规则 |
| --- | --- | --- | --- |
| `name` | Debian 源码包名，例如 `kwin` | `debian/changelog` 解析、基线软件包索引、提测快照 | 小写字母或数字开头，只允许小写字母、数字与 `+` `-` `.`；**不许下划线** |
| `crpProjectName` | 这个包在 CRP 里的项目名，例如 `v25_kwin` | 投递 Release 时按它查 CRP 的 `ProjectID`；从 CRP 导入提测时按它落回本地软件包 | 去空白后非空、不含空白字符、不超过 100 个字符；**允许下划线** |

`crpProjectName` 留空表示「与包名相同」，行为与新增这一列之前完全一样。

两者必须分开的原因：CRP 的项目名普遍带 `v25_` 前缀，而 Debian 包名不允许下划线。把它们当成同一个名字写，
要么登记被拒（`name 格式不对`），要么投到同名的另一个旧项目上（构建成功但打错仓库）。

#### 怎么查到正确的 CRP 项目名

1. 打开 CRP 的项目管理页，按仓库名搜；或直接调接口（`branchID` 是交付分支 ID，`eagle-1071` 是 108）：

   ```bash
   curl -sS -X POST https://crp.uniontech.com/api/project      -H "Authorization: Bearer $CRP_JWT" -H "Content-Type: application/json"      -d '{"page":0,"perPage":0,"projectGroupID":0,"newCommit":false,"archived":false,"branchID":108,"name":"kwin"}'
   ```

2. 结果里挑**名字完全相等**的那一条，抄它的 `Name`（填进 `crpProjectName`）并核对 `RepoUrl` 是不是你要的仓库。
   名字是模糊匹配的，`kwin` 会同时返回 `dde-kwin`、`kwindowsystem`、`kwin-qtrebuild` 等，**不能拿第一条就用**。

`eagle-1071`（分支 108）上实测的例子：

| 包名 `name` | 仓库 `repoPath` | CRP 项目名 `crpProjectName` | CRP 项目 ID | CRP 的 `RepoUrl` |
| --- | --- | --- | --- | --- |
| `kwin` | `deepin-kde/kwin` | `v25_kwin` | 3251 | `ssh://gerrit.uniontech.com:29418/deepin-kde/kwin` |
| `wayland` | `deepin-kde/wayland` | `v25_wayland` | 3040 | `ssh://gerrit.uniontech.com:29418/deepin-kde/wayland` |
| `xwayland` | `deepin-kde/xwayland` | `v25_xwayland` | 3839 | `ssh://gerrit.uniontech.com:29418/deepin-kde/xwayland` |

这张表每一行都做过两条核对（2026-11-20，`eagle-1071`）：

1. CRP 一侧：`POST /api/project` 带 `branchID=108` 与名字，取**名字完全相等**那一条的 `ID` 与 `RepoUrl`；
2. Gerrit 一侧：`GET /a/projects/<urlencode(仓库路径)>` 必须返回 200（仓库真的存在且可读），
   再用 `gitiles`/`GET /a/projects/?p=deepin-kde` 确认分支列表里有 `debian/changelog`。

**不要把 CRP 的 `RepoUrl` 当成 Gerrit 上还在的仓库。** 反例：CRP 项目 3049 `v25_kwindowsystem`
的 `RepoUrl` 写着 `ssh://gerrit.uniontech.com:29418/deepin-kde/kwindowsystem`，
但 `GET /a/projects/deepin-kde%2Fkwindowsystem` 现在返回 **404**（`?p=deepin-kde` 只返回
kwayland、kwin、plasma-wayland-protocols、wayland、xwayland 五个仓库）。照 `RepoUrl` 登记会得到一个
不存在的仓库路径，投递时才失败。所以第 2 步的 Gerrit 核对不能省。

**同一个 CRP 项目名在 `eagle-1071`(108)、`snipe-2500u1`(123)、`snipe-2500u2`(128) 上完全一样**，
所以这一列只需要登记一份，不需要按基线分开存。

#### 登记示例

```bash
curl -fsS -X POST http://127.0.0.1:3000/api/packages \
  -H "Authorization: Bearer $PACKAGE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"kwin","crpProjectName":"v25_kwin","repoPath":"deepin-kde/kwin","defaultBranch":"develop/snipe"}'
```

注意 `wayland` 这个名字在 CRP 上还有两个旧项目（`wayland` 与 `deepin-wayland`，都指向 `base/wayland`）。
只填包名不填 `crpProjectName` 就会命中它们，构建能成功但打的是 `base/wayland`。

---

## 五、定时任务

平台没有常驻调度进程。三个接口必须由外部定时器驱动，否则提测会停在「待建 Topic / 投递中 / 构建中」不动。

| 接口 | 建议频率 | 作用 |
| --- | --- | --- |
| `POST /api/jobs/baseline-sync` | 每小时 | 刷新 CRP 交付分支清单，并刷新被项目选中且缓存过期（1 小时）的基线软件包版本 |
| `POST /api/jobs/build-dispatch` | 每 2 分钟 | 把在跑的提测往前推一步：建 Topic、投下一个该投的包。单轮最多 20 条，按 `last_advanced_at` 从旧到新轮流 |
| `POST /api/jobs/build-poll` | 每 5 分钟 | 回写 Shuttle 构建结果与 CRP 工作流进度，记调度事件流水。单轮最多 50 条，按 `last_polled_at` 轮流 |

crontab 写法（把变量写进 `/etc/crp/cron.env`，权限 0600，由 cron 先 source）：

```cron
0  * * * *   . /etc/crp/cron.env && curl -fsS -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN"          http://127.0.0.1:3000/api/jobs/baseline-sync
*/2 * * * *  . /etc/crp/cron.env && curl -fsS -X POST -H "Authorization: Bearer $BUILD_DISPATCH_JOB_TOKEN" http://127.0.0.1:3000/api/jobs/build-dispatch
*/5 * * * *  . /etc/crp/cron.env && curl -fsS -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN"     http://127.0.0.1:3000/api/jobs/build-poll
```

systemd timer 等价写法（三个各一份 `crp-dispatch.service` + `.timer`）：

```ini
# /etc/systemd/system/crp-dispatch.service
[Unit]
Description=CRP 提测平台：推进投递

[Service]
Type=oneshot
EnvironmentFile=/etc/crp/cron.env
ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer ${BUILD_DISPATCH_JOB_TOKEN}" http://127.0.0.1:3000/api/jobs/build-dispatch
```

```ini
# /etc/systemd/system/crp-dispatch.timer
[Unit]
Description=每 2 分钟推进一次投递

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now crp-dispatch.timer crp-poll.timer crp-sync.timer
```

**判断定时任务活着没有**：看 `build_poll_event` 表有没有新行，或看提测的 `last_advanced_at` / `last_polled_at` 是不是在往前走。

---

## 六、全链路演练（`scripts/e2e.sh`）

### 6.1 它做什么

一条命令在真实 CRP 上跑完整链路，并在结束时自己清理：

1. 建项目经理 → 建项目（基线 `eagle-1071`）；
2. 同步一次基线，拿到投递要用的架构（`Baseline.arches`），打印出来；
3. `POST /api/packages` 登记软件包（`name` + `crpProjectName` 两个名字）；
4. 配依赖，`kwin` 依赖 `wayland`（加 `--with-build-deps` 时同时依赖 `plasma-wayland-protocols`）；
5. `POST /api/releases` 创建提测，断言 `kwin` 排在全部上游之后；
6. 循环调 `build-dispatch` 与 `build-poll`，断言 `kwin` 只在其全部上游成功后才投递；
7. 断言提测到达 `success`，核对提测详情页与构建队列页；
8. 演练 A17：往提测里补一个包（`deepin-kde/xwayland` → CRP 项目 `v25_xwayland`）+ 换掉 wayland 的 Commit，断言旧 Release 被放弃、按新轮次重投（`--skip-a17` 跳过）；
9. 取消提测（删 CRP Release + 放弃 Topic），删掉本次建的项目与经理。

项目经理、项目、软件清单、依赖关系在平台里只有页面表单（Server Action），没有对外 HTTP 接口，所以脚本直接调用表单所用的同一份服务层函数；从「创建提测」开始全部走真实 HTTP 端点。

### 6.1.1 两个名字与提测版本

脚本会把每个包的版本号按 CRP 侧的实际规则换算一次，并在日志里写清楚换算了什么：

| 情况 | 换算 | 例子 |
| --- | --- | --- |
| CRP 项目带 `PkgVerPrefix`，且代码版本以同一个 epoch 开头 | 去掉 epoch（CRP 自己拼前缀） | `4:6.1.57` → `6.1.57` |
| 代码版本带 Debian 修订号（含 `-`） | 截到第一个 `-` 之前 | `1.10.0.32-deepin33-1` → `1.10.0.32` |
| 其他 | 原样使用 | `2:1.21.0.10` |

换算结果通过 `customTag` 传给 `POST /api/releases`。原因见第十一节「待确认的两处」。

### 6.2 前置条件

```bash
# 1. 干净种子库（样式门禁要求纯种子数据；演练会往库里写记录）
pnpm db:migrate && pnpm db:seed

# 2. 样式门禁先跑（它要求纯种子库，演练之后库就不干净了）
scripts/style-check/container.sh

# 3. 环境变量：DATABASE_URL、CRP_USERNAME、CRP_PASSWORD、GERRIT_USERNAME、
#    GERRIT_HTTP_PASSWORD、PACKAGE_API_TOKEN、SYNC_JOB_TOKEN、
#    BUILD_DISPATCH_JOB_TOKEN、BUILD_POLL_JOB_TOKEN（缺一个脚本就直接退出 2）
```

> **样式门禁会在仓库里跑 `next build`，而且容器里是 root。** `scripts/style-check/container.sh`
> 结束时会像对待 `tests/visual` 一样，把 `.next/` 与 `next-env.d.ts` 交还给你，所以紧接着
> `scripts/e2e.sh`（它自己也会 `next build`）能正常写。如果你用的是更早的 `container.sh`，
> 会看到 `EACCES: permission denied, open '<repo>/.next/trace'` 与
> `Build directory is not writeable` —— 那是宿主机上的代码没被交还，按第七节末尾的命令还回来即可。

> **种子数据里的提测会被定时任务真的推进。** 种子把 `1.4.0`、`2.1.0` 这类提测写成「投递中 / 构建中」，
> 定时任务一跑就会去建 Topic、投 Release。2026-11-20 的演练里就出现过：种子提测 `1.4.0` 领到 Topic
> 29206、投出 Shuttle 任务 600347（`deepin-terminal`，`APPLY_FAILED`）。所以在能连真实 CRP 的环境里
> **必须用一次性库**（例如 `docker run -d --name crp-pg ... -p 56090:5432 postgres:17-alpine`），
> 演练完把库删掉。不这么做会往别人的交付分支上留下 Topic 与 Release。

### 6.3 跑

```bash
set -a; . ./.env; set +a                     # 先把 .env 里的变量导入当前 shell（脚本只读环境变量，不读 .env）
scripts/e2e.sh                                # 完整演练，跑完自动清理
scripts/e2e.sh --skip-a17                     # 只跑主链路
scripts/e2e.sh --with-build-deps              # 连带 plasma-wayland-protocols 一起提测（kwin 要它才能编译）
scripts/e2e.sh --fault=upstream               # 故障演练：故意让上游失败，验证下游被阻断
scripts/e2e.sh --poll-seconds=9000            # 等 CRP 构建更久（默认 5400 秒）
scripts/e2e.sh --keep                         # 保留本次记录与 CRP Topic，便于人工看详情页
```

**kwin 一定要带 `--with-build-deps`。** `eagle-1071` 里的 `plasma-wayland-protocols` 是 `1.10.0.28`，
比 `develop/snipe` 上的 kwin 需要的旧，不带这个上游时 kwin 会编译失败（原因见第十一节「环境事实」）。

`--fault=upstream` 会把基线架构临时换成这条分支没有的 `sparc64`，让第一个上游包在 apply 阶段失败，
再断言下游被阻断、提测到终局、原因写清楚；结束时无论成败都把架构还原。

脚本自己 `next build` + `next start`（默认 3200 端口）；`E2E_BASE_URL=http://...` 可以复用已有服务。完整输出同时写进 `~/.cache/crp/e2e-<时间戳>.log`。

### 6.4 结果怎么看

- 退出码 0：链路成立（或故障演练按预期失败）。最后会打印 Topic ID、每个包的 Release ID / Build ID / 版本 / 构建作业状态；
- 退出码 1：会打印「期望 … 实际 …」，并**仍然尝试清理**在 CRP 与库里留下的残留。
  下面这几类都会直接判失败，不会被吞掉：

  | 情况 | 脚本给出的信息 |
  | --- | --- |
  | 定时入口返回体里**本次提测**的 `items[].error`（CRP 密码错、Shuttle 超时等，HTTP 仍是 200） | `POST /api/jobs/build-… 里本次提测（…）报错：<error 原文>` |
  | 同一个返回体里**别的提测**失败（种子数据、别人的提测） | 只打一行日志 `… 里别的提测失败（不影响本次演练）：…`，不判失败 |
  | 本次提测的**已知「还没到时机」**提示（新建 Topic 头几轮 CRP 还没算出工作流进度，`CRP 返回的工作流信息里没有可用的进度（全零对象）`） | 只打一行日志 `… 还没到能判定的时机（不影响判断）：…`，不判失败 |
  | 构建队列页始终没有出现本次提测的版本 | `构建队列页里没有出现本次提测的版本 …（采样结果 queueSeen=false）` |
  | A17 补进来的包没有进新一轮快照 | `新一轮快照里没有补进来的 <包名>：实际有 …` |
  | A17 更新接口的补包名单里没有要补的包 | `更新接口的补包名单里没有 <包名>：实际有 …` |
- 退出码 2：环境变量缺失或服务起不来，什么都没做。

### 6.5 清理边界

| 对象 | 结果 |
| --- | --- |
| CRP Release | 逐个删除（`DELETE /api/topic_releases/{id}`） |
| CRP Topic | **删不掉**，只能 `Abandoned=true`；之后 `GET /topics/{id}` 仍可查到，`GET /topics/{id}/releases` 为空 |
| 库里的提测 / 项目 / 项目经理 | 删除 |
| 软件包登记 | 保留（按名字幂等覆盖，不影响下一次） |

跑完是「该 Topic 里不再有任何 Release，Topic 本身标记为已放弃」，不是「CRP 里查不到」。

### 6.6 四个故障场景怎么自己跑一遍

判定口径只有两条：**错误可读**（人能从返回体或日志看出哪一环坏了）、**不留脏数据**（业务状态不变）。
每个场景前后各取一次库状态做对照，`before.json` 与 `after.json` 的**业务表**（`release`、`build_task`、
`baseline`）除时间戳列外应当一致。**`deliveries`（`webhook_delivery` 的行数）不参与这条比较**：演练自己建的提测
会发出 `release.created`、`build.failed` 这类事件，端点不通时这些记录是 `failed`，而且投递流水是审计记录、
不随提测清理而删除 —— 它变多不代表业务状态脏了。判「脏数据」只看业务表，以及清理后库里是否还剩本次演练的记录。

```bash
snapshot() {
  pnpm exec tsx -e 'import {prisma} from "./lib/db"; (async()=>{
    console.log(JSON.stringify({
      releases: await prisma.release.findMany({select:{version:true,status:true,crpWorkProgress:true,updatedAt:true}}),
      tasks: await prisma.buildTask.findMany({select:{status:true,statusReason:true}}),
      baselines: await prisma.baseline.findMany({select:{name:true,arches:true}}),
      deliveries: await prisma.webhookDelivery.count(),
    }, null, 2));
    await prisma.$disconnect();
  })()'
}
snapshot > before.json
```

**一、CRP 认证过期。** 用一个错误密码起一份服务，再触发两个定时入口：

```bash
rm -f ~/.cache/crp/jwt                     # 有缓存 token 就不会再走登录，先删掉
CRP_PASSWORD=故意写错 pnpm exec next start -p 3205 &
curl -s -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN"   http://127.0.0.1:3205/api/jobs/build-poll
curl -s -X POST -H "Authorization: Bearer $BUILD_DISPATCH_JOB_TOKEN" http://127.0.0.1:3205/api/jobs/build-dispatch
```

算通过：两个入口都是 HTTP 200，`items[].error` 是
`CrpAuthError: POST /login 失败（HTTP 401）：Unauthorized`；`release.status`、`snapshot.status`、
`crp_work_progress` 一个都没动，只有 `updated_at` 变（「这一轮看过它了」）。

**二、Shuttle 超时。** 轮询只对**已投递**的包去问 Shuttle：先 `GET /topics/{topicId}/releases`，按
`release_repository_record.crp_release_id` 对上 CRP 侧的那条 Release，再拿它返回的 `BuildID` 去
`POST /shuttle/task/list`（`lib/build/service.ts` 的 `pollReleaseBuilds`）。所以前提是：

- 库里有一条**未完结**的提测，且它的某个包已经有 `release_repository_record`（真的投出去过）；
- 那条 Release 在 CRP 上还在，并且 CRP 给了 `BuildID`（`> 0`）。

**只有 `build_task` 行不够。** 没有 `repository_record` 的包一个 Shuttle 请求都不会发：整轮一秒返回、
`items[]` 里没有 `error`，看着像「没问题」，其实什么都没测到。这个前提有单测锁住
（`tests/build-poll.test.ts` 的「AC4 Shuttle 超时」：快照带 `crpReleaseId` / `crpBuildId` 才会发请求）。

造这个状态最省事的办法：让 §6.1 的演练先跑起来，等它投出第一个包（日志出现「已投递：」）再动手。
开两个终端：

```bash
# 终端 A：正常跑演练（真的建 Topic、投 Release，跑完自己清理）
scripts/e2e.sh --with-build-deps --skip-a17

# 终端 B：等终端 A 的日志出现「已投递：」之后
node -e 'require("node:net").createServer(()=>{}).listen(3211,"127.0.0.1")' &
SHUTTLE_BASE_URL=http://127.0.0.1:3211/api/shuttle pnpm exec next start -p 3206 &
time curl -s -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN" http://127.0.0.1:3206/api/jobs/build-poll
```

先确认前提真的成立（在终端 B 打之前查一次，应至少有一行 `crp_release_id` 非空）：

```sql
select s.package_name, r.crp_release_id, r.crp_build_id, rel.status as 提测状态
from release_repository_record r
join release_package_snapshot s on s.id = r.snapshot_id
join release rel on rel.id = s.release_id
where rel.status in ('pending', 'dispatching', 'building');
```

`crp_build_id` 为空说明 CRP 还没给构建号（Release 刚建、还在排队），这时也不会问 Shuttle。

> **种子库直接试会失败。** 种子数据里的 `crp_topic_id`（`8841`、`8901` 等）在真实 CRP 上确实存在，
> 但种子里的 `crp_release_id` 早就不在那些主题里了，所以拿纯种子库直接打这一轮会看到
> `checked: 0`、整轮一秒返回 —— 2026-11-20 的功能检测就是这样卡住的。必须先用上面那条 SQL
> 确认有「已投递且 CRP 给了构建号」的包。


算通过：HTTP 200，`items[].error` 是
`ShuttleError: 请求 Shuttle 失败：POST http://127.0.0.1:3211/api/shuttle/task/list：The operation was aborted due to timeout`
（单次请求的超时是 30 秒；每条「已投递且 CRP 给了构建号」的包要各等一次，所以整轮耗时约为「这样的包数 × 30 秒」。
2026-11-20 实测：1 个包 32 秒，其余两条提测是 `CrpNetworkError` 之类的原因，不涉及 Shuttle）。
`release.status`、`snapshot.status`、`build_task.status` 都没变，只有 `last_polled_at` 刷新 ——
查不到结果不等于构建失败，这一点和 8.1 一致。

> 这条错误信息是上层库的原文（英文），比 CRP 那条「30000 毫秒内没有响应，已超时」朴素一些，
> 但指出了出事的接口与原因，够定位。已作为 nit 报给 PL，没有在本单改。

**三、Webhook 端点 500。** 这条不需要服务，直接跑投递的验收脚本：

```bash
pnpm tsx scripts/verify-webhook.ts
```

算通过：脚本自己起一个本机接收端，最后打印「全部通过」。其中「AC2 端点返回 500」一节断言了：
接收端收到 5 次请求（1s→2s→4s→8s 退避）、`webhook_delivery` 记录 `status=failed`、`attempts=5`、
`httpStatus=500`、响应片段入库，且 `emitEvent` 不阻塞主流程；脚本结束后临时工作区与端点被删掉。

**四、上游失败导致阻断。** 用演练脚本的故障开关跑一遍：

```bash
scripts/e2e.sh --fault=upstream --poll-seconds=600
```

算通过：退出码 0，日志里有 `=== 演练结论（故障：上游失败） ===`，上游包是 `failed` 且原因可读
（`Shuttle 任务状态为 APPLY_FAILED…`），下游包的 `阻断自=` 指向上游包名、`原因=因上游 … 构建失败而阻断`，
提测到终局。结束时无论成败都把基线架构还原。

> 这个场景是**注入**的：脚本先把基线架构临时改成这条交付分支没有的 `sparc64`，让第一个上游包在
> apply 阶段失败。除此之外三个场景都是真的把依赖弄坏（错密码、不响应的端点、500 接收端），
> 没有替身实现。写结果时要把「真实链路的证据」与「注入造成的证据」分开标注。

---

## 七、样式门禁

基线是在固定镜像里生成的，本机直接跑会因字体不同误报。必须进容器：

```bash
scripts/style-check/container.sh            # 比对，退出码 0 才算通过
scripts/style-check/container.sh --update   # 重写基线（CI 里会被脚本自己拒绝）
```

三层检查：L1 静态结构（所有页面经 `PageShell`、没有裸 `<table>`、没有内联样式、规则数不低于基线、`:root` 设计变量一致）、L2 计算样式快照（14 个属性严格相等）、L3 几何与整页截图（几何容差 2px、像素差 ≤ 0.5%）。细节见 `docs/STYLE-VERIFICATION.md`。

**前置条件**：库是纯种子数据。跑过 `pnpm test` 或全链路演练的库会多出构建轮询事件，构建队列页会多一张调度事件表，比对必然失败——先退回种子库再跑。

**取样结果不看你配了什么凭据。** 提测详情页会按快照去 Gerrit 读提交信息、按凭据读 CRP 工作流进度，
而这些内容会改变整页高度（实测差 12.4px）。提交进仓库的基线是在没有这些凭据的环境里生成的，所以
`container.sh` 启动容器时用一份**只含 `DATABASE_URL`** 的文件只读盖住仓库根的 `.env`：按 §3.3 配好
CRP / Gerrit 凭据的机器跑出来的结果，和 CI 完全一致。要改这件事只能改门禁怎么固定取样输入，
**不要**在配好凭据的环境里 `--update` 重生成基线 —— 那会让没有凭据的 CI 变红。

`CRP_STYLE_*` 开关（`docs/STYLE-VERIFICATION.md` 第八节那张表）会按原样透传给容器；基线目录与差异
目录必须在仓库内，指到仓库外会直接报错退出（容器只挂载仓库）。

容器以 root 身份执行 `next build`，所以 `.next/` 与 `next-env.d.ts` 在容器里生成时是 root 所有。
`scripts/style-check/container.sh` 跑完会自动交还所有权（与 `tests/visual` 一起），正常不需要手工处理。

如果你手上的脚本还是旧版（只交还 `tests/visual`），或者曾经手工在处理过 root 构建产物，
再构建时会看到 `EACCES: permission denied, open '<repo>/.next/trace'` 与
`Build directory is not writeable`。这时把所有权还回来：

```bash
# 有 sudo 时
sudo chown -R "$(id -u):$(id -g)" .next next-env.d.ts
# 没有 sudo 时，用同一个门禁镜像（容器里是 root）
docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.65.1-noble \
  bash -lc "chown -R $(id -u):$(id -g) /work/.next /work/next-env.d.ts"
```

注意：没有 root 权限时**连删都删不掉**（`.next/server/...` 里的文件属于 root，`rm -rf` 会报「权限不够」），
所以不要指望「删掉重建」绕过这件事。

---

## 八、故障处理

四个演练场景的实测表现与处理办法。判定口径是「错误可读」+「不产生脏数据」。

### 8.1 CRP 认证过期 / 密码错

**现象**：定时任务返回 `200`，但 `items[].error` 是 `CrpAuthError: POST /login 失败（HTTP 401）：Unauthorized`；单条推进接口返回 `502 crp_error`。

**为什么不是 500**：单条提测失败不影响整轮，接口仍回 200，明细在 `items[].error`。

**处理**：

1. 核对 `CRP_USERNAME` / `CRP_PASSWORD`；
2. 删掉 token 缓存强制重新登录：`rm -f ~/.cache/crp/jwt`（或 `CRP_TOKEN_PATH` 指向的那个文件）；
3. 手工验一次：`curl -i -X POST -H "Authorization: Bearer $BUILD_POLL_JOB_TOKEN" http://127.0.0.1:3000/api/jobs/build-poll`。

**不会发生的事**：不会改任何 `release.status` / `snapshot.status` / `crp_work_progress`。查不到不等于构建失败，这一点是设计约束。唯一会动的是 `release.updated_at` / `last_polled_at`（「这一轮看过它了」，防止一直失败的提测占住队首）。

### 8.2 Shuttle 超时

**现象**：同上，`items[].error` 里是 Shuttle 的超时信息；`checked` 为 0 或部分完成。

**处理**：

1. 确认 `SHUTTLE_BASE_URL` 可达：`curl -sS -o /dev/null -w '%{http_code}\n' https://shuttle.uniontech.com/api/shuttle/repo/info`；
2. 单次请求超时是 30 秒，网络抖动会表现为超时，等下一轮即可；
3. 构建卡住时到 Shuttle 页面按 BuildID 查，平台只做状态同步。

**不会发生的事**：同上，状态不变。

### 8.3 Webhook 端点 500

**现象**：`webhook_delivery` 表里出现 `failed` 记录，带状态码与重试次数；提测与构建流程不受影响（事件投递失败不回滚业务）。

**处理**：

1. 在「Webhook」页面看该端点最近一次投递的响应码与片段；
2. 用 `docs/WEBHOOK.md` 的算法复算签名，确认不是签名不符（签名不符是 4xx 类的另一条原因）；
3. 修好接收端后在页面上重投；
4. 长期 5xx 的端点要在平台上停用，避免堆积。

### 8.4 上游构建失败导致阻断

**现象**：上游快照 `failed`，下游快照同样 `failed` 但带 `blockedByPackage` 与 `statusReason`（「因上游 X 构建失败而阻断，本包没有投递」），提测状态为 `failed` 或 `partial_failure`。

**处理**：

1. 看上游包的 Shuttle 日志（详情页能跳到 BuildID）；
2. 修代码或改上游提交后，用「更新提测」换掉上游的 Commit：平台会**先放弃传递下游的旧 Release，再按新轮次重投整条链**；
3. 已转测（`WorkProgress >= 20`）的提测不能再改包，只能新建一条提测。

### 8.5 提测停在「待建 Topic」或「投递中」不动

按顺序排查：

1. 定时任务在跑吗（第五节）？`last_advanced_at` 有没有在变？
2. `BUILD_DISPATCH_JOB_TOKEN` 配了吗？没配时接口一律 401。
3. 看「构建队列」页的调度事件流水，或 `crp_call_log` 表最近 50 条请求。
4. 提测里某个包停在「投递中」超过 5 分钟，下一次推进会把它退回待投递，并先问 CRP 是否已收下（不会重复投递）。

### 8.6 创建提测被 409 挡住

| 提示 | 原因 |
| --- | --- |
| 项目没有软件清单 | 先去项目详情页加包 |
| 依赖成环 | 按提示的回路去软件包页改上游依赖 |
| 基线未同步 | 跑 `POST /api/jobs/baseline-sync`，或到「基线」页点「立即同步」 |
| 同版本号已存在 | 同一项目内版本号唯一，换一个版本号 |

### 8.7 样式门禁失败

先看失败形态：

- 「库里的数据与种子声明不一致」+ 退出码 2：环境不对，退回种子库再跑，不是样式坏了；
- `页面 / 锚点 / 属性 / 期望 / 实际` 一行一条：真的改了样式。若是本次改动导致的，用 `--update` 重写基线并**在同一个 PR 里**说明变了哪些锚点与属性；
- 只报「整页截图 / 像素差」且差的像素很少（百分之一以下）：先连跑三次看是否稳定，再看页面里有没有没写 `orderBy` 的查询导致行序漂移。

### 8.8 提测卡在「构建中」很久

- 真实 CRP 构建要排队，几十条提测同时跑时会更慢；平台每 5 分钟问一次；
- 任务状态成功但作业列表一直为空，等满 15 分钟后平台判失败（没有产物不能给下游用）；
- 需要人工确认构建到底在不在跑，去 Shuttle 按 BuildID 看。

**先按 BuildID 到 Shuttle 看任务状态，不要只看页面。** 三种失败形态，平台的处理各不相同：

| Shuttle 任务状态 | 含义 | 平台的处理 |
| --- | --- | --- |
| `APPLYING` → `APPLY_FAILED` | 申请把这次提测应用到仓库这一步失败了，一个构建作业都没起来 | 判失败，下游被阻断（MKACG-911 之后） |
| `UPLOAD_FAILED` / `UPLOAD_GIVEUP` | 编译或上传失败 | 判失败，下游被阻断 |
| `BUILD_OK` + 没有任何作业 | 任务说成功但没有产物 | 等满 15 分钟判失败 |

`APPLY_FAILED` 的常见原因是**投递时带了这条交付分支不支持的架构**。架构取自基线
（`Baseline.arches`，由基线同步从 Shuttle 的 release-candidate 仓库读出来），所以先确认基线同步过：

```sql
-- 期望看到 6 个：amd64;arm64;i386;loongarch64;mips64el;sw_64
select name, arches, synced_at from baseline where name = 'eagle-1071';
```

架构为空时推进提测会直接 409 并提示「还没有架构列表」。补的办法是在基线页点「立即同步」，
或 `curl -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN" .../api/jobs/baseline-sync`。

---

## 九、日常运维

| 事项 | 做法 |
| --- | --- |
| 看服务是否活着 | `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login` |
| 看定时任务是否活着 | `select max(created_at) from build_poll_event;` |
| 看最近 CRP 请求 | `select * from crp_call_log order by created_at desc limit 20;`（只保留 30 天，由投递任务顺带清理） |
| 看某条提测的投递详情 | `GET /api/releases/{id}/dispatch`（要会话）或详情页 |
| 备份 | `pg_dump "$DATABASE_URL" > crp-$(date +%F).sql` |
| 升级 | `git pull && pnpm install && pnpm db:migrate && pnpm build && 重启服务` |

---

## 十、上线前检查清单

逐条确认，每条都有可复核的证据形式。

- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部退出码 0
- [ ] `scripts/style-check/container.sh` 退出码 0，六个覆盖页面与基线一致
- [ ] `POST /api/jobs/baseline-sync` 返回 200，`list.itemCount > 0`
- [ ] 三个定时入口都能被 cron 触发（`build_poll_event` 有新行）
- [ ] 不带 token 调三个定时入口都返回 401
- [ ] 正确凭据下能建 Topic 并投递一个 Release（真实 CRP）
- [ ] 错误 CRP 密码下，轮询与投递返回可读错误且不改业务状态
- [ ] 上游失败时下游被阻断，`blockedByPackage` 与 `statusReason` 正确
- [ ] Webhook 端点返回 500 时投递记录为 `failed`，业务不受影响
- [ ] 提测详情页、构建队列页、工作台数据与数据库一致
- [ ] 全链路演练 `scripts/e2e.sh --with-build-deps` 退出码 0，提测到 `success`，Topic 链接与详情页截图留证
- [ ] 第十二节的复现检查表 10 条，逐条的现象都对得上（执行者自己走一遍）

> **复现人签字不在这 12 条里，它是另一道门。** AC3「RUNBOOK 被另一位同学按步骤复现成功」由复现人本人
> 在 issue 里发签字评论，执行者与 PL 都不代签，所以它不能作为这张清单的一项 —— 否则清单永远勾不满，
> 而它其实还没发生。签字的写法见第十二节末尾。

---

## 十一、已知缺陷与限制

### 已修复（A16 验收过程中发现并由独立缺陷单修复）

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| 软件包名与 CRP 项目名混用 | 带 `v25_` 前缀的 CRP 项目登记不进来，或投到同名的旧项目上 | MKACG-910：`Package.crpProjectName`，登记方式见第四节 |
| `APPLY_FAILED` 被当成「还在构建」 | CRP 已失败，平台一直显示构建中，提测永不结束 | MKACG-911：`mapShuttleState` 把 `APPLY_FAILED` 判为失败，并给可操作提示 |
| 投递架构写死成常量 | `eagle-1071` 上 apply 直接失败 | MKACG-912：`Baseline.arches` 由基线同步写入，投递按基线取 |

### 待确认的两处（A16 演练发现，尚未开单）

**一、CRP 项目的版本前缀会把 epoch 发两遍**

- 现象：`v25_kwin`（`deepin-kde/kwin` 在 `eagle-1071` 上的 CRP 项目）带 `PkgVerPrefix = "4:"`。
  平台把 `debian/changelog` 的版本原样当提测版本发出去（`4:6.1.57`），CRP 在前面再拼一次前缀，
  apply 阶段就失败：Shuttle 任务 `APPLY_FAILED`、`pkgver` 为空、一个构建作业都没起来。
- 实测（2026-11-20，`scripts/verify-crp.ts` 直接投一条，跑完自己删 Release 与放弃 Topic）：

  ```bash
  CRP_VERIFY_PROJECT="v25_kwin" \
  CRP_VERIFY_PROJECT_BRANCH=develop/snipe \
  CRP_VERIFY_COMMIT=10ec09fcfbd40a1e8ac15bfd8ad299c318a1abd5 \
  CRP_VERIFY_BRANCH=eagle-1071 \
  CRP_VERIFY_TAG="4:6.1.57" \
  pnpm exec tsx scripts/verify-crp.ts
  ```

  结果：Topic 29208 → Release 107535 → Shuttle 任务 600345 `APPLY_FAILED`，`pkgver` 为空，作业 0 个。
  同一提交用 `6.1.57` 投（全链路演练 Topic 29207 里就是这条）能进构建，Shuttle 侧 `pkgver` 变成
  `4:6.1.57-1` —— 说明前缀是 CRP 拼的，调用方不该重复带。
- 当前处理：演练脚本查一次 CRP 的项目前缀，前缀与代码版本的 epoch 相同时用 `customTag` 去掉 epoch
  （见第六节）。产品侧是否要把这件事做成默认行为，待定。
- 影响范围：只影响带 `PkgVerPrefix` 的 CRP 项目（KDE 升级那条线基本都是）。

**二、代码版本带 Debian 修订号时无法投递**

- 现象：`plasma-wayland-protocols` 的 `debian/changelog` 版本是 `1.10.0.32-deepin33-1`，含 `-`；
  `lib/integrations/crp/tag.ts` 的 `validateReleaseTag` 直接拒绝（建提测返回 400）。
- 但 CRP 自己的主题里就有带 `-` 的 Tag（2026-11-20 查主题 29123 的 Release：`mpv` 是
  `0.34.1.10-deepin10`、`base/gtk3.0` 是 `3.24.5.28-deepin28`、`v25_xwayland` 是
  `2:23.1.0.151-deepin151`、`dde-wayland-config` 是 `1.2.16-1`、`base/os-config` 是
  `3000.0.511-deepin1`）。所以不是「CRP 不接受这种版本号」，而是**调用方显式给 Tag 时**
  `POST /new_release` 会拒（`lib/integrations/crp/FINDINGS.md` 里实测 `7.7.7-rc1` →
  `版本中不能包含'-'字符`）；那些带 `-` 的 Tag 是 CRP 从 changelog 自己取的。
- 当前处理：演练脚本把版本截到第一个 `-` 之前（`1.10.0.32`），仍高于仓库里的 `1.10.0.28-1`。
- 影响范围：所有 `debian/changelog` 版本带修订号的包（Debian 包里很常见）。

### 环境事实（不是缺陷，但演练必须知道）

- **kwin 在 `develop/snipe` 上编译需要更新的 `plasma-wayland-protocols`。**
  依据是源码对照，不是猜测：

  | 事实 | 怎么核对的 |
  | --- | --- |
  | kwin 这条分支用到 `ORG_KDE_KWIN_OUTPUTCONFIGURATION_SET_COLOR_MODE_SINCE_VERSION` | `kwin_6.1.52.tar.xz`（`snipe-2500u2` 仓库，与 `develop/snipe` 同一条线）里 `src/wayland/outputmanagement_v1_interface.cpp:339` |
  | `eagle-1071` 里的协议包是 `1.10.0.28`，且整套协议 XML 里没有 `color_mode` | `eagle-1071` 源仓库的 `plasma-wayland-protocols_1.10.0.28.orig.tar.xz`，`grep -r color_mode src/protocols/` 无结果 |
  | 带 `1.10.0.32` 的协议包一起提测后，kwin 构建成功 | 见第六节演练结果（Topic 29207 / 29203） |

  「不带协议包时 kwin 一定编译失败」这一步是按上面两条推出来的，**没有单独跑一次编译失败来做对照**
  （单次真实构建 20 分钟以上）。所以「kwin 依赖 wayland」这两层链在真实环境里跑不到 `success`，
  要把 `plasma-wayland-protocols` 也放进清单（`--with-build-deps`）；这件事按**推断**看待，
  等有人愿意花一次构建时间再做实测对照。
下面列的是仍然存在的限制。

### 其它限制

- CRP 没有删除 Topic 的接口，清理只能「放弃」。
- 平台不推进 CRP 的转测 / 转发布工作流，只读 `WorkProgress`。
- 种子数据里的 `crp_topic_id`（`8901`、`8844` 等）在真实 CRP 上**确实存在**。在没有独立演练库的环境里跑定时任务，会真的读到别人的主题。演练请用一次性库。
- 生产环境的第一个工作区目前只能手工建（`/api/workspaces` 只有 GET，没有创建接口），见 3.6。

---

## 十二、复现检查表（给复现人）

按顺序做，每一步都写了「看什么现象算通过」。哪一步对不上就停在那一步，把现象与日志路径贴进 issue，
不要跳过去做下一步。

| # | 做什么 | 看什么现象算通过 | 大约耗时 |
| --- | --- | --- | --- |
| 1 | 第三节从零部署（3.1 → 3.5）：取代码装依赖 → 起库 → 配 `.env` → `db:migrate` + `db:seed` → 构建启动 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login` 是 `200`；用种子账号（`admin@uniontech.com`）试登录必须 `401` —— 那是占位密码哈希，登不进去才是对的（见 3.6） | 20 分钟 |
| 2 | `scripts/style-check/container.sh` | 最后一行是 `失败 0 项`，六个页面都显示「通过」；跑完 `.next/` 与 `next-env.d.ts` 的所有者是你自己（`ls -ld .next` 不是 `root`），这样第 6 步的 `next build` 才写得进去（旧版脚本的处理见第七节末尾）。结果与你 `.env` 里配没配 CRP / Gerrit 凭据无关：门禁自己固定取样输入（见第七节「取样结果不看你配了什么凭据」） | 2 分钟（镜像已拉过） |
| 3 | 按 3.6 注册一个账号并提成平台管理员 | 刷新 `/dashboard`，列出「安全组 / 桌面核心组 / 系统应用组」三个种子工作区；点「切换到这里」进「桌面核心组」，`/releases?workspace=desktop-core` 列出该工作区的 3 条种子提测（三个工作区合计 5 条：安全组 1、桌面核心组 3、系统应用组 1） | 3 分钟 |
| 4 | 不带 token 打三个定时入口：`POST /api/jobs/baseline-sync`、`/build-dispatch`、`/build-poll` | 三个都返回 `401` | 1 分钟 |
| 5 | 带 `SYNC_JOB_TOKEN` 打 `POST /api/jobs/baseline-sync` | 返回 `200` 且 `list.itemCount > 0`；`/baselines` 页 `eagle-1071` 的架构列是 6 个（`amd64;arm64;i386;loongarch64;mips64el;sw_64`） | 1 分钟 |
| 6 | `set -a; . ./.env; set +a` 之后跑 `scripts/e2e.sh --with-build-deps`（脚本只读环境变量，不读 `.env`，不导入会直接退出 2） | 退出码 `0`；日志最后有 `提测到达 success`、`AC1 证据：Topic …`；打开那个 Topic 与提测详情页，三个包都是成功、顺序是 `plasma-wayland-protocols → wayland → kwin` | 60–90 分钟（真实构建，别中途打断） |
| 7 | 6.6 场景一：CRP 认证过期 | 见 6.6 的「算通过」 | 2 分钟 |
| 8 | 6.6 场景二：Shuttle 超时 | 见 6.6 的「算通过」（要等第 6 步投出第一个包之后才能做，先跑一次 6.6 里那条 SQL 确认） | 1 分钟（与第 6 步同时） |
| 9 | 6.6 场景三：Webhook 端点 500 | 脚本最后打印「全部通过」 | 1 分钟 |
| 10 | 6.6 场景四：上游失败导致阻断 | 见 6.6 的「算通过」 | 5 分钟 |
| 11 | 第十节「上线前检查清单」逐条过 | 12 条全部能勾上 | 10 分钟 |

**第 2 步必须排在第 3 步之前。** 门禁会先跑一次 `pnpm db:seed` 来确认库是纯种子数据（种子里的账号数也是被核对的），
而第 3 步注册的账号会让这项校验不通过、门禁直接退出 2。顺序反过来会看到
「库里的数据与种子声明不一致」，那不是样式坏了。

第 6 步是唯一的长尾：真实 CRP 构建一条链大约一小时。等不到就按第十一节的办法先看卡在哪个包，
把 Topic 号与日志贴出来，不要用「本地能跑」替代。

**签字的写法。** 在 issue MKACG-890 回一条评论，写清「我按第十二节做完了，第几步的现象是 ……」，
附上你跑出来的日志文件路径、Topic 号、以及第 6 步的详情页截图。签字由复现人本人发，Coder 不代签。
