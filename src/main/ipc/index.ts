import { registerFilesHandlers } from './files';
import { registerMcpHandlers } from './mcp';
import { registerNotificationHandlers } from './notifications';
import { registerOrchestrationHandlers } from './orchestration';
import { registerProviderHandlers } from './providers';
import { registerRoleHandlers } from './roles';
import { registerSessionHandlers } from './sessions';
import { registerSettingsHandlers } from './settings';
import { registerSkillHandlers } from './skills';
import { registerTerminalHandlers } from './terminals';
import { registerUpdateHandlers } from './updates';
import { registerUsageHandlers } from './usage';
import { registerWindowHandlers } from './window';
import { registerWorkspaceHandlers } from './workspaces';

/** 注册全部 IPC handler；必须在创建窗口之前调用。 */
export function registerIpcHandlers(): void {
  registerUpdateHandlers();
  registerSettingsHandlers();
  registerWorkspaceHandlers();
  registerFilesHandlers();
  registerTerminalHandlers();
  registerOrchestrationHandlers();
  registerWindowHandlers();
  registerSessionHandlers();
  registerProviderHandlers();
  registerRoleHandlers();
  registerSkillHandlers();
  registerMcpHandlers();
  registerNotificationHandlers();
  registerUsageHandlers();
}
