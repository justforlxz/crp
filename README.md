# CRP 提测平台（Release Hub）

统信 CRP（crp.uniontech.com）之上的提测平台：补上项目化的提测归属、按软件依赖自动排队、可审计的提测快照。产品需求见 [docs/PRD.md](docs/PRD.md)，数据模型初稿见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)。

当前仓库只有项目骨架：能安装、能迁移、能灌种子、能跑检查与测试，**没有任何业务页面，也不调用任何外部接口**。

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

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` / `pnpm start` | 生产构建 / 启动生产服务 |
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `pnpm test` | 单元测试（Node 内置测试运行器，经 tsx 执行 TypeScript） |
| `pnpm db:migrate` | 应用已提交的迁移（`prisma migrate deploy`），空库建表用它 |
| `pnpm db:migrate:dev` | 开发时新建迁移（`prisma migrate dev --name <名称>`） |
| `pnpm db:seed` | 执行 `prisma/seed.ts` 写入种子数据，使用 upsert，可重复执行 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm tsx scripts/verify-gerrit.ts` | 用真实 Gerrit 复核分支、提交与 `debian/changelog` 读取，需要先配好 `GERRIT_*` 三项 |

## 持续集成

`.github/workflows/ci.yml` 在 `push` 到 `main` 与向 `main` 提 PR 时触发，只有一个 job，按顺序执行：

`pnpm install --frozen-lockfile` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm lint` → `pnpm typecheck` → `pnpm test`

- Node 用 `22.x`，与 `package.json` 的 `engines.node` 同一条版本线；pnpm 的版本由 `package.json` 的 `packageManager` 决定（当前 `pnpm@9.15.9`），由 `pnpm/action-setup` 安装，不在 workflow 里重复写版本。
- 数据库用 `postgres:17` 的 service container，账号、库名、`DATABASE_URL` 都写在 workflow 里，不需要任何 secret。
- 迁移和种子在 CI 里真跑：`_prisma_migrations` 能建表、种子能写入，才说明「空库可迁移」这条在干净环境成立。

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

Gerrit 这三项只被 `lib/integrations/gerrit/` 读取，未配置时该模块抛错，其余功能不受影响。匿名访问会被 302 跳登录页，实测行为见 `lib/integrations/gerrit/FINDINGS.md`。

验证脚本 `scripts/verify-crp.ts` 另需 `CRP_VERIFY_PROJECT`、`CRP_VERIFY_PROJECT_BRANCH`、`CRP_VERIFY_COMMIT`，
说明见 `.env.example` 与 `lib/integrations/crp/FINDINGS.md`。

`.env` 已被 `.gitignore` 忽略，仓库里不出现任何真实凭据；新增变量时同步更新 `.env.example` 与本节表格。

## 目录结构

```
app/                 Next.js App Router：页面与将来的 Route Handler
lib/                 领域逻辑
lib/db.ts            Prisma Client 单例（带 pg 驱动适配器）
lib/env.ts           环境变量读取与校验
lib/integrations/    CRP、Shuttle、Gerrit 客户端（职责边界见其 README）
lib/integrations/gerrit/  Gerrit 与 gitiles 客户端、changelog 解析、实测记录 FINDINGS.md
scripts/             接真实外部系统的验证脚本，不经 CI 执行
prisma/              schema、migrations、seed
tests/               单元测试
docs/                PRD 与数据模型文档
generated/           `prisma generate` 产物，不入库
```

## 数据库约定

- 迁移文件入库：`prisma/migrations/` 中的 SQL 是建表唯一来源，空库靠 `pnpm db:migrate` 建表。
- 改 schema 后用 `pnpm db:migrate:dev --name <名称>` 生成新迁移，不要手改已提交的迁移。
- 本节点只放了一个示例模型 `HealthCheck` 验证链路，业务表在 A5 节点按 `docs/DATA_MODEL.md` 建模。
