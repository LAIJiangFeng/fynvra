import { randomUUID } from 'node:crypto';
import { asRecord } from '@shared/guards';
import type { AppMessageBoxRequest, AppMessageBoxType } from '@shared/types/appDialog';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  type BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import { translate } from '../i18n';

/** Renderer 在这段时间内没确认接手，就回退到原生对话框，保证用户始终能操作。 */
const ACK_TIMEOUT_MS = 3_000;

export type AppMessageBoxOptions = MessageBoxOptions & {
  /** 危险操作按钮的下标；只影响应用内对话框的样式，原生回退时忽略 */
  destructiveId?: number;
};

interface Pending {
  owner: WebContents;
  /** 首次确认返回 true；重复或已结束返回 false */
  ack(): boolean;
  acked(): boolean;
  respond(response: unknown): void;
}
const pending = new Map<string, Pending>();

function isIndex(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;
}

async function showNative(
  win: BrowserWindow | null | undefined,
  options: AppMessageBoxOptions
): Promise<number> {
  const { destructiveId: _destructiveId, ...native } = options;
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, native)
      : await dialog.showMessageBox(native);
  return response;
}

/**
 * 用应用内对话框显示提示框，返回按钮下标（语义同 `dialog.showMessageBox` 的 response）。
 * - 没有可用窗口、webContents 已销毁 / 崩溃，或约 3 秒内收不到 Renderer 的 ack：回退原生对话框；
 * - 收到 ack 后不设超时；等待期间窗口关闭、销毁、崩溃或页面重载，返回 `cancelId`；
 * - 同一个 requestId 只处理一次，只接受目标窗口的回复。
 */
export function showAppMessageBox(
  win: BrowserWindow | null | undefined,
  options: AppMessageBoxOptions
): Promise<number> {
  const buttons = options.buttons ?? [];
  const owner = win && !win.isDestroyed() ? win.webContents : undefined;
  if (!win || !owner || owner.isDestroyed() || owner.isCrashed() || buttons.length === 0)
    return showNative(win, options);
  const cancelId = isIndex(options.cancelId, buttons.length) ? options.cancelId : 0;
  const request: AppMessageBoxRequest = {
    requestId: randomUUID(),
    type: (options.type ?? 'none') as AppMessageBoxType,
    title: options.title ?? '',
    message: options.message,
    detail: options.detail ?? '',
    buttons: [...buttons],
    defaultId: isIndex(options.defaultId, buttons.length) ? options.defaultId : 0,
    cancelId,
    ...(isIndex(options.destructiveId, buttons.length)
      ? { destructiveId: options.destructiveId }
      : {}),
  };
  const { requestId } = request;

  return new Promise<number>((resolve) => {
    let done = false;
    let acked = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      pending.delete(requestId);
      owner.removeListener('destroyed', lost);
      owner.removeListener('render-process-gone', lost);
      owner.removeListener('did-start-navigation', navigated);
      if (!win.isDestroyed()) win.removeListener('closed', lost);
    };
    const finish = (response: number) => {
      if (done) return;
      cleanup();
      resolve(response);
    };
    const fallback = () => {
      if (done) return;
      cleanup();
      showNative(win, options).then(resolve, () => resolve(cancelId));
    };
    // Renderer 接手前丢失：回退原生；接手后丢失：按取消处理。
    const lost = () => (acked ? finish(cancelId) : fallback());
    const navigated = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean
    ): void => {
      if (mainFrame && !inPlace) lost();
    };
    const timer = setTimeout(() => {
      if (!acked) fallback();
    }, ACK_TIMEOUT_MS);
    pending.set(requestId, {
      owner,
      ack: () => {
        if (done || acked) return false;
        acked = true;
        clearTimeout(timer);
        return true;
      },
      acked: () => acked,
      respond: (response) =>
        finish(isIndex(response, request.buttons.length) ? response : cancelId),
    });
    owner.once('destroyed', lost);
    owner.on('render-process-gone', lost);
    owner.on('did-start-navigation', navigated);
    win.once('closed', lost);
    try {
      owner.send(IPC_CHANNELS.APP_DIALOG_REQUEST, request);
    } catch {
      fallback();
    }
  });
}

export function registerAppDialogHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_DIALOG_SHOWN, (event, raw: unknown): IpcResult => {
    const entry = typeof raw === 'string' ? pending.get(raw) : undefined;
    if (!entry || entry.owner !== event.sender || !entry.ack())
      return { ok: false, error: translate('common.invalidArgs') };
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.APP_DIALOG_RESPOND, (event, raw: unknown): IpcResult => {
    const reply = asRecord(raw);
    const entry = typeof reply?.requestId === 'string' ? pending.get(reply.requestId) : undefined;
    if (!reply || !entry || entry.owner !== event.sender || !entry.acked())
      return { ok: false, error: translate('common.invalidArgs') };
    entry.respond(reply.response);
    return { ok: true };
  });
}
