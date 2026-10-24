import { ORCHESTRATOR_ROLE_ID, type Role } from '@fynvra/core';
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
