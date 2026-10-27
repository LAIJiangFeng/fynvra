import type {
  ListRemoteModelsResult,
  ProviderImportEntry,
} from '../../../../preload/domains/providers';
import { translate } from '../../../i18n';
import { mergeRemoteModels } from '../mergeRemoteModels';
import type { ProviderStore } from '../providerStore';
import { remoteModelsTarget } from '../remoteModels/input';
import { listRemoteModels, type RemoteModelsTarget } from '../remoteModels/listRemoteModels';
import { type FetchLike, PROVIDER_TEST_TIMEOUT_MS } from '../testProvider';

const CONCURRENCY = 3;

type ImportedProvider = Pick<ProviderImportEntry, 'id' | 'name'>;
type ImportModelStore = Pick<ProviderStore, 'get' | 'upsert'>;

/** 导入已落盘：独立拉取每个服务，失败只记摘要，不回滚导入。结果顺序与导入顺序一致。 */
export async function fetchImportedModels(
  imported: readonly ImportedProvider[],
  { store, fetch }: { store: ImportModelStore; fetch: FetchLike }
): Promise<ProviderImportEntry[]> {
  const results: ProviderImportEntry[] = [];
  const queue = imported.entries();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, imported.length) }, async () => {
      for (const [index, provider] of queue) {
        const models = await fetchOne(provider.id, store, fetch);
        results[index] = { id: provider.id, name: provider.name, models };
      }
    })
  );
  return results;
}

async function fetchOne(
  providerId: string,
  store: ImportModelStore,
  fetch: FetchLike
): Promise<ProviderImportEntry['models']> {
  try {
    const stored = await store.get(providerId);
    const target = remoteModelsTarget({ providerId }, stored);
    if (!target.ok) return { error: target.error };
    const remote = await fetchWithDeadline(target.target, fetch);
    if (!remote.ok) return { error: remote.error };

    // 网络请求期间服务可能被编辑或删除：合并最新模型，不恢复已删除的服务。
    const current = await store.get(providerId);
    if (!current) return { error: translate('providers.notFound') };
    const { models, added } = mergeRemoteModels(current.models, remote.models);
    const saved = await store.upsert({
      id: current.id,
      name: current.name,
      api: current.api,
      baseUrl: current.baseUrl,
      enabled: current.enabled,
      models,
    });
    // 不回传 store 的原始错误：路径、URL 或服务端响应可能含秘密。
    if (!saved.ok) return { error: translate('importers.modelsSaveFailed') };
    return { added, total: saved.provider.models.length };
  } catch {
    return { error: translate('importers.modelsSaveFailed') };
  }
}

/** 15 秒是整个服务的期限（包括回退、响应体读取），而非每次 HTTP 请求各计 15 秒。 */
async function fetchWithDeadline(
  target: RemoteModelsTarget,
  fetch: FetchLike
): Promise<ListRemoteModelsResult> {
  const controller = new AbortController();
  let status: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ListRemoteModelsResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: translate('importers.modelsTimeout') });
    }, PROVIDER_TEST_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      timeout,
      listRemoteModels(target, {
        signal: controller.signal,
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          status = response.ok ? undefined : response.status;
          return response;
        },
      }),
    ]);
    if (result.ok) return result;
    return {
      ok: false,
      error: controller.signal.aborted
        ? translate('importers.modelsTimeout')
        : status === undefined
          ? translate('importers.modelsFetchFailed')
          : `HTTP ${status}`,
    };
  } catch {
    return { ok: false, error: translate('importers.modelsFetchFailed') };
  } finally {
    clearTimeout(timer);
  }
}
