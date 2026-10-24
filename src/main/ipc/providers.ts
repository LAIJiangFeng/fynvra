import { join } from 'node:path';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, ipcMain, net } from 'electron';
import type {
  ProviderListResult,
  ProviderSaveResult,
  ProviderTestResult,
} from '../../preload/domains/providers';
import { isRegistryId } from '../services/providers/jsonRegistry';
import { parseProviderUpsert } from '../services/providers/parseProviderInput';
import {
  createProviderStore,
  type ProviderStore,
  toProviderView,
} from '../services/providers/providerStore';
import { testProvider } from '../services/providers/testProvider';
import { sendToAllWindows } from '../windows/createAppWindow';

let store: ProviderStore | null = null;

/**
 * Main 唯一的 providers.json 句柄（含明文 key），createModelResolver 也读它。
 * userData 路径在启动早期才确定，所以延迟创建。
 */
export function getProviderStore(): ProviderStore {
  store ??= createProviderStore({ filePath: join(app.getPath('userData'), 'providers.json') });
  return store;
}

export function registerProviderHandlers(): void {
  // 返回给 Renderer 的一律是 toProviderView：只有 hasApiKey 与末 4 位
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, async (): Promise<ProviderListResult> => {
    try {
      return { ok: true, providers: (await getProviderStore().list()).map(toProviderView) };
    } catch (error) {
      return { ok: false, error: `读取模型服务失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_UPSERT,
    async (_event, raw: unknown): Promise<ProviderSaveResult> => {
      const parsed = parseProviderUpsert(raw);
      if (!parsed.ok) return parsed;
      try {
        const result = await getProviderStore().upsert(parsed.input);
        if (!result.ok) return result;
        sendToAllWindows(IPC_CHANNELS.PROVIDERS_CHANGED);
        return { ok: true, provider: toProviderView(result.provider) };
      } catch (error) {
        return { ok: false, error: `保存模型服务失败：${errorMessage(error)}` };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_REMOVE,
    async (_event, rawId: unknown): Promise<IpcResult> => {
      if (!isRegistryId(rawId)) return { ok: false, error: '无效的模型服务 id' };
      try {
        const removed = await getProviderStore().remove(rawId);
        if (!removed) return { ok: false, error: '模型服务不存在' };
        sendToAllWindows(IPC_CHANNELS.PROVIDERS_CHANGED);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `删除模型服务失败：${errorMessage(error)}` };
      }
    }
  );

  // 只收 id：key 从 providers.json 取，不经过 Renderer
  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_TEST,
    async (_event, rawId: unknown): Promise<ProviderTestResult> => {
      if (!isRegistryId(rawId)) return { ok: false, error: '无效的模型服务 id' };
      try {
        const provider = await getProviderStore().get(rawId);
        if (!provider) return { ok: false, error: '模型服务不存在' };
        return await testProvider(provider, { fetch: (url, init) => net.fetch(url, init) });
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
