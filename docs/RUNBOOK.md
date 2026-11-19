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

### 3.6 生产环境首次初始化（没有 seed 的情况）

当前版本没有「创建工作区」的接口或页面，第一次初始化需要手工做两步。**这是一处已知的部署缺口**，见第十一节。

1. 打开 `/register` 注册第一个账号（注册后自动登录，但还不是管理员）。
2. 提升为平台管理员，并建一个工作区：

```sql
-- 表名是 app_user，不是 user
UPDATE app_user SET is_platform_admin = true WHERE email = 'you@uniontech.com';

INSERT INTO workspace (id, slug, name, created_at, updated_at)
VALUES (gen_random_uuid(), 'desktop-core', '桌面核心组', now(), now());
```

3. 用管理员账号登录，进入「工作台 → 邀请成员」把同事拉进工作区；工作区角色在成员接口里分配。
4. 手动触发一次基线同步，让 CRP 的交付分支进入平台：

```bash
curl -fsS -X POST -H "Authorization: Bearer $SYNC_JOB_TOKEN" \
  http://127.0.0.1:3000/api/jobs/baseline-sync
```

同步完成后「基线」页面会出现全部交付分支（实测 108 条）。

5. 到「基线」页面点一次「立即同步」（`trigger=manual, force=true`），把每个基线的软件包版本拉下来。

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
| `kwindowsystem` | `deepin-kde/kwindowsystem` | `v25_kwindowsystem` | 3049 | `ssh://gerrit.uniontech.com:29418/deepin-kde/kwindowsystem` |

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
2. `POST /api/packages` 登记两个包，配一条 `kwin → wayland` 依赖；
3. `POST /api/releases` 创建提测，断言依赖拓扑顺序是「wayland 在前」；
4. 循环调 `build-dispatch` 与 `build-poll`，断言先投 wayland、wayland 成功后才投 kwin；
5. 断言提测到达 `success`，核对提测详情页与构建队列页；
6. 演练 A17：补一个包 + 换掉 wayland 的 Commit，断言旧 Release 被放弃、按新轮次重投（`--skip-a17` 跳过）；
7. 取消提测（删 CRP Release + 放弃 Topic），删掉本次建的项目与经理。

项目经理、项目、软件清单、依赖关系在平台里只有页面表单（Server Action），没有对外 HTTP 接口，所以脚本直接调用表单所用的同一份服务层函数；从「创建提测」开始全部走真实 HTTP 端点。

### 6.2 前置条件

```bash
# 1. 干净种子库（样式门禁要求纯种子数据；演练会往库里写记录）
pnpm db:migrate && pnpm db:seed

# 2. 样式门禁先跑（它要求纯种子库，演练之后库就不干净了）
scripts/style-check/container.sh

# 3. 环境变量：DATABASE_URL、CRP_*、GERRIT_*、PACKAGE_API_TOKEN、
#    BUILD_DISPATCH_JOB_TOKEN、BUILD_POLL_JOB_TOKEN
```

### 6.3 跑

```bash
scripts/e2e.sh                          # 完整演练，跑完自动清理
scripts/e2e.sh --skip-a17               # 只跑主链路
scripts/e2e.sh --poll-seconds=9000      # 等 CRP 构建更久（默认 5400 秒）
scripts/e2e.sh --keep                   # 保留本次记录与 CRP Topic，便于人工看详情页
```

脚本自己 `next build` + `next start`（默认 3200 端口）；`E2E_BASE_URL=http://...` 可以复用已有服务。完整输出同时写进 `~/.cache/crp/e2e-<时间戳>.log`。

### 6.4 结果怎么看

- 退出码 0：链路成立。最后会打印 Topic ID、每个包的 Release ID / Build ID / 版本 / 构建作业状态；
- 退出码 1：会打印「期望 … 实际 …」，并**仍然尝试清理**在 CRP 与库里留下的残留；
- 退出码 2：环境变量缺失或服务起不来，什么都没做。

### 6.5 清理边界

| 对象 | 结果 |
| --- | --- |
| CRP Release | 逐个删除（`DELETE /api/topic_releases/{id}`） |
| CRP Topic | **删不掉**，只能 `Abandoned=true`；之后 `GET /topics/{id}` 仍可查到，`GET /topics/{id}/releases` 为空 |
| 库里的提测 / 项目 / 项目经理 | 删除 |
| 软件包登记 | 保留（按名字幂等覆盖，不影响下一次） |

跑完是「该 Topic 里不再有任何 Release，Topic 本身标记为已放弃」，不是「CRP 里查不到」。

---

## 七、样式门禁

基线是在固定镜像里生成的，本机直接跑会因字体不同误报。必须进容器：

```bash
scripts/style-check/container.sh            # 比对，退出码 0 才算通过
scripts/style-check/container.sh --update   # 重写基线（CI 里会被脚本自己拒绝）
```

三层检查：L1 静态结构（所有页面经 `PageShell`、没有裸 `<table>`、没有内联样式、规则数不低于基线、`:root` 设计变量一致）、L2 计算样式快照（14 个属性严格相等）、L3 几何与整页截图（几何容差 2px、像素差 ≤ 0.5%）。细节见 `docs/STYLE-VERIFICATION.md`。

**前置条件**：库是纯种子数据。跑过 `pnpm test` 或全链路演练的库会多出构建轮询事件，构建队列页会多一张调度事件表，比对必然失败——先退回种子库再跑。

容器以 root 身份执行 `next build`，跑完仓库里的 `.next/` 与 `next-env.d.ts` 会变成 root 所有。之后要在本机再构建，先交还所有权：

```bash
sudo chown -R "$(id -u):$(id -g)" .next next-env.d.ts
```

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

**先按 BuildID 到 Shuttle 看任务状态，不要只看页面。** 2026-11-19 的演练撞到过两种情况，页面都会一直显示「构建中」：

| Shuttle 任务状态 | 含义 | 平台当前的处理 |
| --- | --- | --- |
| `APPLYING` → `APPLY_FAILED` | 申请把这次提测应用到仓库这一步就失败了，一个构建作业都没起来 | **当成「还在构建」**，提测永远停在构建中，下游永不被阻断 |
| `UPLOAD_FAILED` / `UPLOAD_GIVEUP` | 构建失败 | 判失败，正常阻断下游 |

`APPLY_FAILED` 的实测原因是**投递时带了这条交付分支不支持的架构**：平台固定发
`amd64;mips64el;arm64;sw64;loong64`（`lib/integrations/crp/config.ts` 的 `CRP_DEFAULT_ARCHES`），
而 `eagle-1071` 只支持 `amd64`、`i386`、`arm64`。同一提交、同一版本号：

- 带 5 个架构 → `APPLY_FAILED`，`pkgver` 为空、作业列表为空；
- 只带 `amd64;arm64` → apply 通过，`pkgver` 变成 `2:1.21.0.10-1`，作业排队。

当前版本没有配置架构列表的入口（恒量与请求体都没有对应字段），遇到 `APPLY_FAILED` 只能
到 Shuttle 上看状态、人工把这条提测取消，等缺陷单修完再演练。见第十一节。

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
- [ ] 全链路演练 `scripts/e2e.sh` 退出码 0
- [ ] 本文档被另一位同学按步骤复现成功（复现人签字）

---

## 十一、已知缺陷与限制

### 缺陷 A：投递固定写死 5 个架构，交付分支不支持的架构会让 apply 直接失败

- 现象：`POST /new_release` 里 `Arches` 恒为 `amd64;mips64el;arm64;sw64;loong64`
  （`lib/integrations/crp/releases.ts:58` 用的是 `CRP_DEFAULT_ARCHES`）。`eagle-1071` 只支持
  `amd64`、`i386`、`arm64`，多出来的 `mips64el`、`sw64`、`loong64` 让 CRP 在 apply 阶段就失败。
- 证据：同一提交（`deepin-kde/wayland` `develop/eagle` `587bde6b`）、同一版本号（`2:1.21.0.10`）：

  | 请求里的 `Arches` | CRP `BuildState` | Shuttle 任务 | 构建作业 |
  | --- | --- | --- | --- |
  | `amd64;mips64el;arm64;sw64;loong64` | `APPLY_FAILED` | 600315 `APPLY_FAILED`，`pkgver` 空 | 空 |
  | `amd64;arm64` | 通过 | 600317，`pkgver=2:1.21.0.10-1` | `amd64:WAIT, arm64:WAIT` |

- 影响：只要交付分支不支持这 5 个架构里的任何一个，这条提测的每个包都会在 apply 阶段失败。
- 当前没有办法在配置里绕开：`CRP_DEFAULT_ARCHES` 是常量，`CrpSubmitReleaseInput.arches` 没有供
  调用方填写的入口，`.env` 里也没有对应变量。

### 缺陷 B：未识别的终态被当成「构建中」，提测会永久卡住

- 现象：`lib/build/status.ts` 的 `mapShuttleState` 只认 `UPLOAD_FAILED`、`UPLOAD_GIVEUP`、
  `FAILED` 等几个失败值，`APPLY_FAILED` 不在其中，被归成「还在构建」。而「任务成功但作业为空」
  的那条 15 分钟兜底只在**任务状态为成功**时才生效，`APPLY_FAILED` 走不到。
- 证据：本轮演练里 Shuttle 任务 600315 从 `02:11:59` 起就是 `APPLY_FAILED`，平台连续 40 分钟
  把这条提测报成 `building`、把 `wayland` 报成 `building`，`kwin` 一直停在「待投递」。
- 影响：CRP 侧已经失败，平台却认为还在构建，提测永远不结束、下游永不被阻断，页面只能靠人盯着 Shuttle 才能发现。

**已修复**：2026-11-19 的全链路验收发现「软件包名与 CRP 项目名不是一个名字，投递与导入都对不上」，
由 MKACG-910 修复（`Package.crpProjectName` 字段 + `lib/packages/crpProject.ts` 统一解析），
登记方式见本文第四节。

下面列的是仍然存在的限制。

### 其它限制

- CRP 没有删除 Topic 的接口，清理只能「放弃」。
- 平台不推进 CRP 的转测 / 转发布工作流，只读 `WorkProgress`。
- 种子数据里的 `crp_topic_id`（`8901`、`8844` 等）在真实 CRP 上**确实存在**。在没有独立演练库的环境里跑定时任务，会真的读到别人的主题。演练请用一次性库。
- 生产环境的第一个工作区目前只能手工建（`/api/workspaces` 只有 GET，没有创建接口），见 3.6。
