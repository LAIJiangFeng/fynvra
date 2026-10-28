import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { notificationPreferencesOf } from '@shared/types/settings';
import { app, BrowserWindow, ipcMain } from 'electron';
import { translate } from '../i18n';
import type { AgentHostService } from '../services/agentHost/agentHost';
import {
  isDesktopNotificationSupported,
  showDesktopNotification,
} from '../services/notifications/desktop';
import { createNotifier } from '../services/notifications/notifier';
import type { ViewState } from '../services/notifications/rules';
import type { OrchestrationRegistry } from '../services/orchestration/registry';
import { parseSessionId } from '../services/sessions/sessionStore';
import { getOrchestrationRegistry } from './orchestration';
import { getAgentHost } from './sessions';
import { getSettingsFile } from './settings';

/** 通知的事件来源：生产为 agent host 与编排注册表，测试注入假的 */
export interface NotificationSources {
  host(): Pick<AgentHostService, 'get' | 'observe'>;
  registry(): Pick<OrchestrationRegistry, 'onMessage'>;
}

const testNotification = () => ({ title: 'Fynvra', body: translate('notifications.testBody') });

/** 各窗口（webContents id）里正看着的会话，由 Renderer 经 notifications:set-viewing 报告 */
const viewing = new Map<number, string | null>();

const preferences = () => notificationPreferencesOf(getSettingsFile().read().preferences);

/** 聚焦的窗口与它正看着的会话 */
function currentView(): ViewState {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed()) return { focused: false, viewingSessionId: null };
  return { focused: true, viewingSessionId: viewing.get(focused.webContents.id) ?? null };
}

/**
 * 桌面通知：接上 agent host 的会话事件（含单向工具通知）与各工作区收件箱的消息，
 * 并注册 `notifications:*`。弹出规则见 services/notifications。
 */
export function registerNotificationHandlers(
  sources: NotificationSources = { host: getAgentHost, registry: getOrchestrationRegistry }
): void {
  const notifier = createNotifier({
    preferences,
    view: currentView,
    session: (sessionId) => sources.host().get(sessionId),
    show: showDesktopNotification,
  });
  sources.host().observe({
    event: (envelope) => notifier.sessionEvent(envelope),
  });
  sources.registry().onMessage((_workspaceId, message) => notifier.message(message));

  // 用户点的：不看聚焦、启动静默期与开关（总开关关着时界面上的按钮不可用）
  ipcMain.handle(IPC_CHANNELS.NOTIFICATIONS_TEST, (_event, ...args: unknown[]): IpcResult => {
    if (args.length > 0) return { ok: false, error: translate('common.invalidArgs') };
    if (!isDesktopNotificationSupported())
      return { ok: false, error: translate('notifications.unsupported') };
    try {
      showDesktopNotification({ ...testNotification(), silent: !preferences().sound });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, (event, raw: unknown): IpcResult => {
    const input = parseSetViewingInput(raw);
    if (!input) return { ok: false, error: translate('common.invalidSessionId') };
    const { sender } = event;
    if (!viewing.has(sender.id)) sender.once('destroyed', () => viewing.delete(sender.id));
    viewing.set(sender.id, input.sessionId);
    return { ok: true };
  });

  app.on('before-quit', () => notifier.clear());
}

/** `{ sessionId }`：会话 id 或 null（没在看会话），不接受其他字段 */
export function parseSetViewingInput(raw: unknown): { sessionId: string | null } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'sessionId')) return null;
  if (record.sessionId === null) return { sessionId: null };
  const sessionId = parseSessionId(record.sessionId);
  return sessionId ? { sessionId } : null;
}
