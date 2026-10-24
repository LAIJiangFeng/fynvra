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
import { sendToAllWindows } from '../windows/createAppWindow';

let store: RoleStore | null = null;

/** Main 唯一的角色仓库：内置角色常驻内存，自定义角色是 userData/roles/<id>.json。 */
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
      return { ok: false, error: `读取角色失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ROLES_GET, async (_event, rawId: unknown): Promise<RoleResult> => {
    if (!isValidRoleId(rawId)) return { ok: false, error: '无效的角色 id' };
    try {
      const role = await getRoleStore().get(rawId);
      return role ? { ok: true, role } : { ok: false, error: '角色不存在' };
    } catch (error) {
      return { ok: false, error: `读取角色失败：${errorMessage(error)}` };
    }
  });

  // 整个角色经 parseRole 收窄（未知字段丢弃）；系统提示词随角色文件落盘，不进 settings.json
  ipcMain.handle(IPC_CHANNELS.ROLES_SAVE, async (_event, raw: unknown): Promise<RoleResult> => {
    const parsed = parseRole(raw);
    if (!parsed.ok) return { ok: false, error: `角色无效：${parsed.error}` };
    if (isBuiltinRoleId(parsed.role.id)) {
      return { ok: false, error: '内置角色只读，请复制为新角色后修改' };
    }
    try {
      const result = await getRoleStore().save(parsed.role);
      if (!result.ok) return result;
      sendToAllWindows(IPC_CHANNELS.ROLES_CHANGED);
      return { ok: true, role: result.role };
    } catch (error) {
      return { ok: false, error: `保存角色失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ROLES_REMOVE, async (_event, rawId: unknown): Promise<IpcResult> => {
    if (!isValidRoleId(rawId)) return { ok: false, error: '无效的角色 id' };
    if (isBuiltinRoleId(rawId)) return { ok: false, error: '内置角色不可删除' };
    try {
      const result = await getRoleStore().remove(rawId);
      if (!result.ok) return result;
      sendToAllWindows(IPC_CHANNELS.ROLES_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `删除角色失败：${errorMessage(error)}` };
    }
  });
}
