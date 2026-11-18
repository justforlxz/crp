/**
 * 接口响应里出现的账号、会话、工作区形态。
 *
 * 单独一层是为了让「响应里绝不出现明文密码或哈希」这件事可以被单测断言：
 * 这里每个函数都是逐个字段挑出来的，不会把整行数据库记录原样回给前端。
 */
import type { Role } from "./roles";
import type { AccountRecord, WorkspaceRecord } from "./store";

export type PublicAccount = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
};

/** 账号对外形态：四个字段，没有 `password_hash`。 */
export function publicAccount(account: AccountRecord): PublicAccount {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    isPlatformAdmin: account.isPlatformAdmin,
  };
}

/** 工作区对外形态，带当前账号在该工作区的角色。 */
export function publicWorkspace(
  workspace: WorkspaceRecord,
  role: Role,
): { id: string; slug: string; name: string; role: Role } {
  return { id: workspace.id, slug: workspace.slug, name: workspace.name, role };
}

/** 项目对外形态。 */
export function publicProject(project: {
  id: string;
  key: string;
  name: string;
}): { id: string; key: string; name: string } {
  return { id: project.id, key: project.key, name: project.name };
}
