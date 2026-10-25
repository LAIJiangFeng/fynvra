import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import {
  isBuiltinRoleId,
  isValidRoleId,
  JsonFileRoleStore,
  parseRole,
  type RoleStore,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, ipcMain } from 'electron';
import type { RoleListResult, RoleResult } from '../../preload/domains/roles';
import { translate } from '../i18n';
import { sendToAllWindows } from '../windows/createAppWindow';

let store: RoleStore | null = null;

/** Main 唯一的角色仓库：内置覆盖配置和自定义角色均存于 userData/roles/<id>.json。 */
export function getRoleStore(): RoleStore {
  store ??= new JsonFileRoleStore({
    fs,
    dir: join(app.getPath('userData'), 'roles'),
    onInvalidFile: (file, error) => console.warn(`[roles] 跳过无效的角色文件 ${file}：${error}`),
  });
  return store;
}

export function registerRoleHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ROLES_LIST, async (): Promise<RoleListResult> => {
    try {
      return { ok: true, roles: await getRoleStore().list() };
    } catch (error) {
      return { ok: false, error: translate('roles.readFailed', { error: errorMessage(error) }) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ROLES_GET, async (_event, rawId: unknown): Promise<RoleResult> => {
    if (!isValidRoleId(rawId)) return { ok: false, error: translate('roles.invalidId') };
    try {
      const role = await getRoleStore().get(rawId);
      return role ? { ok: true, role } : { ok: false, error: translate('roles.notFound') };
    } catch (error) {
      return { ok: false, error: translate('roles.readFailed', { error: errorMessage(error) }) };
    }
  });

  // 整个角色经 parseRole 收窄（未知字段丢弃）；系统提示词随角色文件落盘，不进 settings.json
  ipcMain.handle(IPC_CHANNELS.ROLES_SAVE, async (_event, raw: unknown): Promise<RoleResult> => {
    const parsed = parseRole(raw);
    if (!parsed.ok)
      return { ok: false, error: translate('roles.invalid', { error: parsed.error }) };
    try {
      const result = await getRoleStore().save(parsed.role);
      if (!result.ok) return result;
      sendToAllWindows(IPC_CHANNELS.ROLES_CHANGED);
      return { ok: true, role: result.role };
    } catch (error) {
      return { ok: false, error: translate('roles.saveFailed', { error: errorMessage(error) }) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ROLES_REMOVE, async (_event, rawId: unknown): Promise<IpcResult> => {
    if (!isValidRoleId(rawId)) return { ok: false, error: translate('roles.invalidId') };
    if (isBuiltinRoleId(rawId)) return { ok: false, error: translate('roles.builtinUndeletable') };
    try {
      const result = await getRoleStore().remove(rawId);
      if (!result.ok) return result;
      sendToAllWindows(IPC_CHANNELS.ROLES_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: translate('roles.removeFailed', { error: errorMessage(error) }) };
    }
  });
}
