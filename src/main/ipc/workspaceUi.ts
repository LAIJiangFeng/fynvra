import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { parseWorkspaceId } from '@shared/types/workspace';
import { parseWorkspaceUi, type UiFlushMode, type UiFlushReply } from '@shared/types/workspaceUi';
import { app, type BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { translate } from '../i18n';
import { createWorkspaceUiService } from '../services/workspaceUi';
import { getFilesService } from './files';
import { terminalBelongsTo } from './terminals';
import { getWorkspaceService } from './workspaces';

let service: ReturnType<typeof createWorkspaceUiService> | undefined;
export function getWorkspaceUiService() {
  service ??= createWorkspaceUiService(
    join(app.getPath('userData'), 'workspace-ui'),
    getFilesService()
  );
  return service;
}
type Lease = { owner: WebContents; token: string; seq: number };
const leases = new Map<string, Lease>();
const tracked = new WeakSet<WebContents>();
const replies = new Map<string, { owner: WebContents; finish(reply: UiFlushReply): void }>();
function track(owner: WebContents) {
  if (tracked.has(owner)) return;
  tracked.add(owner);
  const release = () => {
    for (const [id, lease] of leases) if (lease.owner === owner) leases.delete(id);
    for (const [requestId, pending] of replies)
      if (pending.owner === owner) pending.finish({ requestId, ok: false, dirty: false });
  };
  owner.once('destroyed', release);
  owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) release();
  });
}
export async function removeWorkspaceUi(id: string) {
  leases.delete(id);
  await getWorkspaceUiService().remove(id);
}
export function registerWorkspaceUiHandlers() {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UI_SELECTION, async (_event, raw: unknown) => {
    const id = raw === undefined ? undefined : parseWorkspaceId(raw);
    if (id === null || (id && !getWorkspaceService().get(id)))
      return { ok: false, error: translate('common.workspaceNotFound') };
    try {
      const selected = await getWorkspaceUiService().selection(id);
      return {
        ok: true,
        workspaceId: selected && getWorkspaceService().get(selected) ? selected : null,
      };
    } catch {
      return { ok: false, error: translate('workspaceUi.failed') };
    }
  });
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UI_LOAD, async (event, raw: unknown) => {
    const id = parseWorkspaceId(raw);
    if (!id || !getWorkspaceService().get(id))
      return { ok: false, error: translate('common.workspaceNotFound') };
    const previous = leases.get(id);
    if (previous && previous.owner !== event.sender)
      return { ok: false, error: translate('workspaceUi.failed') };
    track(event.sender);
    const lease = { owner: event.sender, token: randomUUID(), seq: 0 };
    leases.set(id, lease);
    try {
      const loaded = await getWorkspaceUiService().load(id);
      if (leases.get(id) !== lease || !getWorkspaceService().get(id)) throw new Error('expired');
      return { ok: true, token: lease.token, ...loaded };
    } catch {
      return { ok: false, error: translate('workspaceUi.failed') };
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UI_SAVE,
    async (event, raw: unknown): Promise<IpcResult> => {
      const input = asRecord(raw),
        id = parseWorkspaceId(input?.workspaceId);
      const lease = id ? leases.get(id) : undefined;
      if (
        !input ||
        !id ||
        !lease ||
        lease.owner !== event.sender ||
        input.token !== lease.token ||
        typeof input.seq !== 'number' ||
        !Number.isSafeInteger(input.seq) ||
        input.seq <= lease.seq ||
        !getWorkspaceService().get(id)
      )
        return { ok: false, error: translate('workspaceUi.failed') };
      const snapshot = parseWorkspaceUi(input.snapshot, id);
      if (
        !snapshot ||
        snapshot.tabs.some(
          (tab) => tab.kind === 'terminal' && !terminalBelongsTo(tab.id, event.sender, id)
        )
      )
        return { ok: false, error: translate('workspaceUi.limits') };
      lease.seq = input.seq;
      try {
        await getWorkspaceUiService().save(
          id,
          snapshot,
          () => leases.get(id) === lease && !!getWorkspaceService().get(id)
        );
        return { ok: true };
      } catch {
        return { ok: false, error: translate('workspaceUi.failed') };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UI_FLUSHED, (event, raw: unknown): IpcResult => {
    const reply = asRecord(raw);
    if (
      !reply ||
      typeof reply.requestId !== 'string' ||
      typeof reply.ok !== 'boolean' ||
      typeof reply.dirty !== 'boolean'
    )
      return { ok: false, error: translate('common.invalidArgs') };
    const pending = replies.get(reply.requestId);
    if (pending?.owner !== event.sender)
      return { ok: false, error: translate('workspaceUi.failed') };
    pending.finish({ requestId: reply.requestId, ok: reply.ok, dirty: reply.dirty });
    return { ok: true };
  });
}
function requestFlush(owner: WebContents, mode: UiFlushMode): Promise<UiFlushReply> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      finish({ requestId, ok: false, dirty: false });
      if (!owner.isDestroyed())
        owner.send(IPC_CHANNELS.WORKSPACE_UI_FLUSH, { requestId, mode: 'resume' });
    }, 30_000);
    const finish = (reply: UiFlushReply) => {
      clearTimeout(timer);
      replies.delete(requestId);
      resolve(reply);
    };
    replies.set(requestId, { owner, finish });
    if (owner.isDestroyed()) finish({ requestId, ok: false, dirty: false });
    else owner.send(IPC_CHANNELS.WORKSPACE_UI_FLUSH, { requestId, mode });
  });
}
const preparing = new WeakMap<BrowserWindow, Promise<boolean>>();
/** Called before any window is destroyed and before agent shutdown. */
export function prepareWorkspaceWindowClose(win: BrowserWindow): Promise<boolean> {
  const existing = preparing.get(win);
  if (existing) return existing;
  const pending = (async () => {
    const first = await requestFlush(win.webContents, 'check');
    if (!first.ok) {
      if (!win.isDestroyed())
        dialog.showMessageBoxSync(win, {
          type: 'error',
          message: translate('workspaceUi.failed'),
          buttons: [translate('common.cancel')],
        });
      return false;
    }
    let mode: UiFlushMode = 'keep';
    if (first.dirty) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: translate('files.unsavedTitle'),
        message: translate('files.unsavedMessage'),
        detail: translate('workspaceUi.exitHint'),
        buttons: [
          translate('common.cancel'),
          translate('workspaceUi.keep'),
          translate('files.discard'),
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice === 0) return false;
      mode = choice === 2 ? 'discard' : 'keep';
    }
    const final = await requestFlush(win.webContents, mode);
    if (!final.ok && !win.isDestroyed())
      dialog.showMessageBoxSync(win, {
        type: 'error',
        message: translate('workspaceUi.failed'),
        buttons: [translate('common.cancel')],
      });
    return final.ok;
  })()
    .catch(() => {
      if (!win.isDestroyed())
        dialog.showMessageBoxSync(win, {
          type: 'error',
          message: translate('workspaceUi.failed'),
          buttons: [translate('common.cancel')],
        });
      return false;
    })
    .finally(() => preparing.delete(win));
  preparing.set(win, pending);
  return pending;
}
