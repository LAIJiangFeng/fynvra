import { ORCHESTRATOR_ROLE_ID, type Role, WORKER_ROLE_ID } from '@fynvra/core';
import type { T } from '@/i18n';
import { useRolesStore } from '@/stores/roles';
import { roleChoices } from './roleChoices';

/** 可选角色：角色库（含内置角色）；还没读到或读取失败时退回内置的 orchestrator / worker。 */
export function useRoles(): readonly Role[] {
  return roleChoices(useRolesStore((state) => state.roles));
}

/** 主 agent：内置 orchestrator，或工具策略为 orchestrator 的自定义角色。 */
export function isOrchestratorRole(roleId: string, roles: readonly Role[]): boolean {
  if (roleId === ORCHESTRATOR_ROLE_ID) return true;
  return roles.find((role) => role.id === roleId)?.tools === 'orchestrator';
}

/** 角色的描述：内置角色按界面语言（字典 sessions.builtinRoles），自定义角色原样 */
export function roleDescription(role: Role, t: T): string | undefined {
  if (role.builtin && (role.id === ORCHESTRATOR_ROLE_ID || role.id === WORKER_ROLE_ID)) {
    return t(`sessions.builtinRoles.${role.id}`);
  }
  return role.description;
}
