import {
  BUILTIN_ROLES,
  getBuiltinRole,
  ORCHESTRATOR_ROLE_ID,
  type Role,
  WORKER_ROLE_ID,
} from '@fynvra/core';
import type { T } from '../../i18n';

// 新建会话弹层的角色选择（纯函数；不碰 roles store，便于在 node 环境测试）

/** 可选角色：角色库（内置在前）；还没读到、读取失败或为空时退回内置的 orchestrator / worker。 */
export function roleChoices(roles: readonly Role[]): readonly Role[] {
  return roles.length > 0 ? roles : BUILTIN_ROLES;
}

/** 选中的角色：`wantedId` 还在列表里就用它，否则 orchestrator，再否则第一个。 */
export function pickRole(roles: readonly Role[], wantedId: string): Role | undefined {
  return (
    roles.find((role) => role.id === wantedId) ??
    roles.find((role) => role.id === ORCHESTRATOR_ROLE_ID) ??
    roles[0]
  );
}

/** 只翻译尚未修改的内置描述，用户修改或清空后原样展示。 */
export function roleDescription(role: Role, t: T): string | undefined {
  if (
    role.builtin &&
    (role.id === ORCHESTRATOR_ROLE_ID || role.id === WORKER_ROLE_ID) &&
    role.description === getBuiltinRole(role.id)?.description
  )
    return t(`sessions.builtinRoles.${role.id}`);
  return role.description;
}
