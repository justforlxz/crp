# 账号、会话与角色守卫

本目录是平台自建账号体系的全部实现：注册、登录、会话、工作区切换、成员邀请、四级角色与
`requireRole()` 服务端守卫。后续节点（软件包、Webhook、项目、提测）写服务端入口时**只准**用这里的守卫，
不要各自解析 Cookie 或各写一套角色判断。

## 文件分工

| 文件 | 职责 | 是否碰数据库 |
| --- | --- | --- |
| `credentials.ts` | 邮箱归一化与格式校验、密码长度规则、Argon2id 哈希与校验 | 否 |
| `session.ts` | 会话令牌生成与哈希、有效期与滑动续期、Cookie 属性 | 否 |
| `roles.ts` | 角色高低、账号级与工作区级判定、角色中文名 | 否 |
| `rate-limit.ts` | 登录失败限流（同账号 5 次 / 分钟，进程内） | 否 |
| `dto.ts` | 接口响应的账号、工作区、项目形态（逐字段挑，不带哈希） | 否 |
| `store.ts` | Prisma 读写，全部用 `select` 挑字段 | 是 |
| `server.ts` | Cookie 读写、`requireRole()`、`requirePageAuth()`、登录/登出 | 是 |
| `http.ts` | 读 JSON 请求体、造错误响应 | 否 |

判定与策略都在纯函数模块里，单测直接跑它们，不需要数据库：`tests/auth-*.test.ts`。

## 角色与作用域

| 角色 | 作用域 | 存储位置 |
| --- | --- | --- |
| 平台管理员 | 全局 | `app_user.is_platform_admin` |
| 项目经理 | 项目 | `membership.role = project_manager` |
| 开发者 | 工作区 | `membership.role = developer` |
| 只读成员 | 工作区 | `membership.role = reader` |

高低按「只读 < 开发者 < 项目经理 < 平台管理员」比较：要求 `developer` 时，`project_manager` 也放行。
项目作用域内「只能动自己负责的项目」这种更细的约束，由项目接口查完归属后自行收紧，本模块不管。

## 在 Route Handler 里用守卫

```ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await context.params;

  // 工作区级：没有成员关系一律 404，角色不够 403，没登录 401
  const guard = await requireRole({ scope: "workspace", workspaceId, role: "developer" });
  if (!guard.ok) return guard.response;

  const { account, role } = guard.auth; // role 是生效角色（管理员为 platform_admin）
  // ...
  return NextResponse.json({ ok: true });
}
```

- 只要求「登录了」用 `{ scope: "account", role: "reader" }`；要求平台管理员用 `{ scope: "account", role: "platform_admin" }`。
- 拦下时的响应形如 `{ error: { code, message } }`，状态码 401 / 403 / 404。**不要**把 401 写成 500，也不要把越权写成 403：
  工作区没有成员关系时统一 404，避免泄露「这个工作区存在」。
- 页面用 `requirePageAuth("/dashboard")`：未登录会 302 到 `/login?next=...`。

## 接口清单

| 方法与路径 | 权限 | 作用 |
| --- | --- | --- |
| `POST /api/auth/register` | 公开 | 注册并登录 |
| `POST /api/auth/login` | 公开，失败限流 | 登录 |
| `POST /api/auth/logout` | 公开、幂等 | 撤销会话并清 Cookie |
| `GET /api/auth/session` | 登录 | 当前账号、角色、当前工作区、可见工作区 |
| `GET /api/workspaces` | 登录 | 工作区清单（管理员看全部） |
| `POST /api/workspaces/{id}/switch` | 该工作区成员 | 切换当前工作区 |
| `GET /api/workspaces/{id}/projects` | 该工作区成员 | 项目清单（给权限验收用，增删改在 A10） |
| `POST /api/workspaces/{id}/members` | 平台管理员 | 建号或补成员关系并分配角色 |

页面：`/login`、`/register`、`/dashboard`（受保护）。

## 会话

- Cookie 名 `crp_session`，`httpOnly`、`SameSite=Lax`、生产环境 `Secure`，有效期 7 天。
- Cookie 里是 32 字节随机令牌；库里只存它的 SHA-256（`session.token_hash`）。
- 每次读取会话都会检查撤销与过期，并按需滑动续期（最多每小时写一次库）。
- 撤销是「置 `revoked_at`」，行保留供排查。

## 建可登录账号

种子里的 5 个账号 `password_hash` 是占位串，不能登录（见 `docs/DATA_MODEL.md` 第七节）。要登录：

- 走 `/register` 注册；或
- 用平台管理员调 `POST /api/workspaces/{id}/members` 建号并直接分配工作区与角色。

第一个平台管理员需要手工指定：注册一个账号后把 `app_user.is_platform_admin` 置为 `true`。
