import { BUILTIN_ROLES, ORCHESTRATOR_ROLE_ID, type Role } from '@fynvra/core';

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
