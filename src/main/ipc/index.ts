import { registerAppDialogHandlers } from './appDialog';
import { registerFilesHandlers } from './files';
import { registerInstructionHandlers } from './instructions';
import { registerMcpHandlers } from './mcp';
import { registerNotificationHandlers } from './notifications';
import { registerOrchestrationHandlers } from './orchestration';
import { registerPluginHandlers } from './plugins';
import { registerProviderHandlers } from './providers';
import { registerRoleHandlers } from './roles';
import { registerSessionHandlers } from './sessions';
import { registerSettingsHandlers } from './settings';
import { registerSkillHandlers } from './skills';
import { registerTerminalHandlers } from './terminals';
import { registerUpdateHandlers } from './updates';
import { registerUsageHandlers } from './usage';
import { registerWindowHandlers } from './window';
import { registerWorkflowHandlers } from './workflows';
import { registerWorkspaceHandlers } from './workspaces';
import { registerWorkspaceUiHandlers } from './workspaceUi';

/** 注册全部 IPC handler；必须在创建窗口之前调用。 */
export function registerIpcHandlers(): void {
  registerAppDialogHandlers();
  registerUpdateHandlers();
  registerSettingsHandlers();
  registerWorkspaceHandlers();
  registerFilesHandlers();
  registerWorkspaceUiHandlers();
  registerTerminalHandlers();
  registerOrchestrationHandlers();
  registerWindowHandlers();
  registerSessionHandlers();
  registerProviderHandlers();
  registerRoleHandlers();
  registerWorkflowHandlers();
  registerSkillHandlers();
  registerInstructionHandlers();
  registerMcpHandlers();
  registerPluginHandlers();
  registerNotificationHandlers();
  registerUsageHandlers();
}
