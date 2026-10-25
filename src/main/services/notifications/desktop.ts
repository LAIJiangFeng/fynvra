import { IPC_CHANNELS } from '@shared/types/ipc';
import { BrowserWindow, Notification } from 'electron';
import type { SessionFocus } from '../../../preload/domains/notifications';
import { sendToWindow } from '../../windows/createAppWindow';
import type { DesktopNotification } from './notifier';

/**
 * 弹出过的通知留着引用（有上限）：对象被 GC 后点击不再触发 click。
 * 关闭（含超时收进通知中心）后也不放，用户在通知中心里点还能回到会话。
 */
const live = new Set<Notification>();
const MAX_LIVE = 50;

export function isDesktopNotificationSupported(): boolean {
  return Notification.isSupported();
}

/** 交给系统弹出（silent 时不放提示音）；点击时把窗口拉到前台，有目标会话就切过去 */
export function showDesktopNotification({
  title,
  body,
  silent,
  target,
}: DesktopNotification): void {
  if (!isDesktopNotificationSupported()) return;
  const notification = new Notification({ title, body, silent });
  notification.on('click', () => {
    live.delete(notification);
    focusApp(target);
  });
  notification.on('failed', () => live.delete(notification));
  live.add(notification);
  for (const oldest of live) {
    if (live.size <= MAX_LIVE) break;
    live.delete(oldest);
  }
  notification.show();
}

/** 还原（最小化时）并聚焦主窗口；有目标会话时推 sessions:focus 让 Renderer 切过去 */
function focusApp(target: SessionFocus | undefined): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (target) sendToWindow(win, IPC_CHANNELS.SESSIONS_FOCUS, target);
}
