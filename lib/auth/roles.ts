/**
 * 角色模型与访问判定。
 *
 * 四级角色的作用域：
 *
 * | 角色 | 作用域 | 存储位置 |
 * | --- | --- | --- |
 * | 平台管理员 | 全局 | `app_user.is_platform_admin` |
 * | 项目经理 | 项目 | `membership.role = project_manager` |
 * | 开发者 | 工作区 | `membership.role = developer` |
 * | 只读成员 | 工作区 | `membership.role = reader` |
 *
 * 角色高低按「只读 < 开发者 < 项目经理 < 平台管理员」比较，满足一个要求即视为满足更低的要求。
 * 项目作用域的细分（只允许本人负责的项目）由项目相关接口在做完归属查询后自行收紧，
 * 本模块只回答「这个人在这个工作区里达到某个角色没有」。
 *
 * 本模块是纯函数：不读 Cookie、不查库，判定结果由调用方拿到的数据算出，方便单测。
 */

/** 平台角色，含账号级的平台管理员。 */
export type Role = "platform_admin" | "project_manager" | "developer" | "reader";

/** 工作区成员角色，与数据库枚举 `workspace_role` 的取值一致。 */
export type WorkspaceRoleName = "project_manager" | "developer" | "reader";

/** 角色的中文名，页面与错误提示共用，避免各处各写一套。 */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  platform_admin: "平台管理员",
  project_manager: "项目经理",
  developer: "开发者",
  reader: "只读成员",
};

/** 可以分配给工作区成员的角色，顺序与数据库枚举一致。 */
export const WORKSPACE_ROLES: readonly WorkspaceRoleName[] = [
  "project_manager",
  "developer",
  "reader",
];

/** 类型守卫：请求体里的 `role` 字段是不是合法的成员角色。 */
export function isWorkspaceRole(value: string): value is WorkspaceRoleName {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** 角色高低：数字越大权限越高。 */
const ROLE_RANK: Readonly<Record<Role, number>> = {
  reader: 1,
  developer: 2,
  project_manager: 3,
  platform_admin: 4,
};

/** 当前账号在某个范围内的身份。`workspaceRole` 为空表示在这个工作区里没有成员关系。 */
export type Subject =
  | { kind: "anonymous" }
  | { kind: "user"; isPlatformAdmin: boolean; workspaceRole: WorkspaceRoleName | null };

/** 判定结果：放行时给出生效的角色，拦下时给出 HTTP 状态与稳定的错误码。 */
export type Decision =
  | { allowed: true; role: Role }
  | { allowed: false; status: 401 | 403 | 404; code: string; message: string };

/** 账号级要求只允许这两种：登录即可（reader），或必须是平台管理员。 */
export type AccountRoleRequirement = "reader" | "platform_admin";

/** 工作区级要求，平台管理员不写成要求，因为它在任何工作区都放行。 */
export type WorkspaceRoleRequirement = WorkspaceRoleName;

/** 角色比较：`actual` 达到或超过 `required` 即为真。 */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** 账号生效角色：平台管理员就是平台管理员，其余账号在工作区外只算只读成员。 */
export function accountRole(isPlatformAdmin: boolean): Role {
  return isPlatformAdmin ? "platform_admin" : "reader";
}

const UNAUTHENTICATED: Extract<Decision, { allowed: false }> = {
  allowed: false,
  status: 401,
  code: "unauthenticated",
  message: "请先登录",
};

/**
 * 账号级判定：`/api/workspaces`、`/api/auth/session` 这类不针对具体工作区的入口用它。
 *
 * 未登录一律 401；登录了但要求是平台管理员而账号不是，返回 403。
 */
export function unauthenticatedDecision(): Extract<Decision, { allowed: false }> {
  return UNAUTHENTICATED;
}

export function decideAccountAccess(subject: Subject, required: AccountRoleRequirement): Decision {
  if (subject.kind === "anonymous") {
    return UNAUTHENTICATED;
  }

  const role = accountRole(subject.isPlatformAdmin);

  if (!hasRole(role, required)) {
    return {
      allowed: false,
      status: 403,
      code: "forbidden",
      message: "当前账号没有这个操作的权限",
    };
  }

  return { allowed: true, role };
}

/**
 * 工作区级判定：所有 `/api/workspaces/{id}/**` 与工作区页面用它。
 *
 * 顺序固定，三步都不能省：
 *
 * 1. 未登录 → 401，先问身份再问对象。
 * 2. 平台管理员 → 直接放行，不需要成员关系。
 * 3. 没有成员关系 → 404，与「工作区不存在」同一个响应，不泄露存在性。
 * 4. 有成员关系但角色不够 → 403。
 */
export function decideWorkspaceAccess(subject: Subject, required: WorkspaceRoleRequirement): Decision {
  if (subject.kind === "anonymous") {
    return UNAUTHENTICATED;
  }

  if (subject.isPlatformAdmin) {
    return { allowed: true, role: "platform_admin" };
  }

  if (subject.workspaceRole === null) {
    return {
      allowed: false,
      status: 404,
      code: "workspace_not_found",
      message: "工作区不存在",
    };
  }

  if (!hasRole(subject.workspaceRole, required)) {
    return {
      allowed: false,
      status: 403,
      code: "forbidden",
      message: "当前角色不能执行这个操作",
    };
  }

  return { allowed: true, role: subject.workspaceRole };
}
