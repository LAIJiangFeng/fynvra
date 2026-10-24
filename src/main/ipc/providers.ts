import { join } from 'node:path';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, ipcMain, net } from 'electron';
import type {
  ListRemoteModelsResult,
  ProviderImportResult,
  ProviderListResult,
  ProviderSaveResult,
  ProviderScanImportsResult,
  ProviderTestResult,
} from '../../preload/domains/providers';
import {
  createProviderImporter,
  type ProviderImporter,
} from '../services/providers/import/providerImporter';
import { isRegistryId } from '../services/providers/jsonRegistry';
import { parseProviderUpsert } from '../services/providers/parseProviderInput';
import {
  createProviderStore,
  type ProviderStore,
  toProviderView,
} from '../services/providers/providerStore';
import {
  parseListRemoteModelsInput,
  remoteModelsTarget,
} from '../services/providers/remoteModels/input';
import { listRemoteModels } from '../services/providers/remoteModels/listRemoteModels';
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

let importer: ProviderImporter | null = null;

/** 「从本机导入」：最近一次扫描的结果（含明文 key）只缓存在这里。 */
function getProviderImporter(): ProviderImporter {
  importer ??= createProviderImporter({ store: getProviderStore() });
  return importer;
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

  // 只读扫描本机配置；返回脱敏候选，含 key 的结果留在 Main 的缓存里
  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_SCAN_IMPORTS,
    (_event, raw: unknown): Promise<ProviderScanImportsResult> => getProviderImporter().scan(raw)
  );

  // 只收候选 id：key 从扫描缓存取，不经过 Renderer
  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_IMPORT,
    async (_event, raw: unknown): Promise<ProviderImportResult> => {
      const result = await getProviderImporter().import(raw);
      if (result.ok && result.imported.length > 0) {
        sendToAllWindows(IPC_CHANNELS.PROVIDERS_CHANGED);
      }
      return result;
    }
  );

  // 已保存的服务只传 id，key 从 providers.json 取；表单里新填的 key 只在这一跳进入 Main。
  // 与 providers:test 走同一条网络路径（net.fetch：Chromium 网络栈与系统代理），返回的模型视图里没有 key
  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_LIST_REMOTE_MODELS,
    async (_event, raw: unknown): Promise<ListRemoteModelsResult> => {
      const parsed = parseListRemoteModelsInput(raw);
      if (!parsed.ok) return parsed;
      try {
        const { providerId } = parsed.input;
        const stored =
          providerId === undefined ? undefined : await getProviderStore().get(providerId);
        const target = remoteModelsTarget(parsed.input, stored);
        if (!target.ok) return target;
        return await listRemoteModels(target.target, {
          fetch: (url, init) => net.fetch(url, init),
        });
      } catch (error) {
        return { ok: false, error: `拉取模型列表失败：${errorMessage(error)}` };
      }
    }
  );
}
