import { registerOrchestrationHandlers } from './orchestration';
import { registerSessionHandlers } from './sessions';
import { registerMcpHandlers } from './mcp';
import { registerProviderHandlers } from './providers';
import { registerRoleHandlers } from './roles';
import { registerSettingsHandlers } from './settings';
import { registerSkillHandlers } from './skills';
import { registerWindowHandlers } from './window';
import { registerWorkspaceHandlers } from './workspaces';

/** 注册全部 IPC handler；必须在创建窗口之前调用。 */
export function registerIpcHandlers(): void {
  registerSettingsHandlers();
  registerWorkspaceHandlers();
  registerOrchestrationHandlers();
  registerWindowHandlers();
  registerSessionHandlers();
  registerProviderHandlers();
  registerRoleHandlers();
  registerSkillHandlers();
  registerMcpHandlers();
}
