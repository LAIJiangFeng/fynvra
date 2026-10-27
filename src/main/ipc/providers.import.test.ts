import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderImportResult,
  ProviderScanImportsResult,
} from '../../preload/domains/providers';
import type { ScannedCandidate } from '../services/providers/import/scan';
import type { ProviderStore } from '../services/providers/providerStore';
import type { FetchLike } from '../services/providers/testProvider';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(),
  fetch: vi.fn<FetchLike>(),
  scan: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
  net: { fetch: mocks.fetch },
}));

vi.mock('../services/providers/import/scan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providers/import/scan')>()),
  scanProviderImports: mocks.scan,
}));

const KEY = 'sk-import-secret-key-1234';
const URL_SECRET = 'private-url-token-5678';
const EXISTING = {
  id: 'kept',
  name: 'Custom',
  contextWindow: 1234,
  maxOutput: 512,
  reasoning: false,
};
let store: ProviderStore;

const invoke = <T>(channel: string, raw?: unknown) =>
  mocks.handlers.get(channel)?.({}, raw) as Promise<T>;
const importIds = (candidateIds: string[]) =>
  invoke<ProviderImportResult>(IPC_CHANNELS.PROVIDERS_IMPORT, { candidateIds });

function candidate(
  name = 'Relay',
  patch: Partial<ScannedCandidate['input']> = {}
): ScannedCandidate {
  const input: ScannedCandidate['input'] = {
    name,
    api: 'openai-completions',
    baseUrl: `https://${name.toLowerCase()}.example.com/v1`,
    enabled: true,
    models: [EXISTING],
    apiKey: KEY,
    ...patch,
  };
  return {
    view: {
      id: crypto.randomUUID(),
      source: 'cc-switch',
      sourceLabel: `CC Switch · ${name}`,
      name,
      api: input.api,
      models: input.models,
      hasApiKey: Boolean(input.apiKey),
      isCurrent: true,
    },
    input,
  };
}

async function scan(candidates: ScannedCandidate[] = [candidate()]): Promise<string[]> {
  mocks.scan.mockResolvedValue({ candidates, warnings: [] });
  const result = await invoke<ProviderScanImportsResult>(IPC_CHANNELS.PROVIDERS_SCAN_IMPORTS);
  if (!result.ok) throw new Error(result.error);
  return result.candidates.map(({ id }) => id);
}

function reply(body: unknown = { data: [{ id: 'remote' }] }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
  };
}

function expectNoSecrets(result: unknown) {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(KEY);
  expect(serialized).not.toContain(URL_SECRET);
  expect(serialized).not.toContain('https://');
  expect(serialized).not.toContain('apiKey');
}

beforeEach(async () => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.send.mockReset();
  mocks.fetch.mockReset();
  mocks.scan.mockReset();
  // 本测试的磁盘写入与清理都留在自己的 worktree。
  mocks.userData = mkdtempSync(join(process.cwd(), 'node_modules', '.provider-import-'));
  const { getProviderStore, registerProviderHandlers } = await import('./providers');
  registerProviderHandlers();
  store = getProviderStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(mocks.userData, { recursive: true, force: true });
});

describe('providers:import 自动拉取模型', () => {
  it('只收候选 id，使用已保存的 key 经 net.fetch 拉取，合并落盘后才广播并返回数量摘要', async () => {
    const ids = await scan([
      candidate('Relay', { baseUrl: `https://relay.example.com/${URL_SECRET}/${KEY}/v1` }),
    ]);
    mocks.fetch.mockResolvedValue(
      reply({
        data: [
          { id: 'remote-z' },
          { id: 'kept' },
          { id: 'remote-a' },
          { id: 'remote-z' },
          { id: KEY },
        ],
      })
    );
    let broadcastDisk = '';
    mocks.send.mockImplementation(() => {
      broadcastDisk = readFileSync(join(mocks.userData, 'providers.json'), 'utf8');
    });

    const result = await importIds(ids);
    expect(result).toEqual({
      ok: true,
      imported: [{ id: 'relay', name: 'Relay', models: { added: 2, total: 3 } }],
      skipped: [],
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://relay.example.com/${URL_SECRET}/${KEY}/v1/models`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${KEY}` },
        signal: expect.any(AbortSignal),
        redirect: 'error',
      })
    );
    const saved = await store.get('relay');
    expect(saved?.apiKey).toBe(KEY);
    expect(saved?.models).toEqual([
      EXISTING,
      { id: 'remote-a', name: 'remote-a' },
      { id: 'remote-z', name: 'remote-z' },
    ]);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.PROVIDERS_CHANGED);
    expect(JSON.parse(broadcastDisk).providers[0].models).toEqual(saved?.models);
    expectNoSecrets(result);
  });

  it('HTTP 失败不影响导入，错误只包含状态码，不回显 key、URL 或服务端原文', async () => {
    const ids = await scan();
    mocks.fetch.mockResolvedValue(
      reply({ error: { message: `${KEY} https://host/${URL_SECRET}` } }, 401)
    );
    const result = await importIds(ids);
    expect(result).toEqual({
      ok: true,
      imported: [{ id: 'relay', name: 'Relay', models: { error: 'HTTP 401' } }],
      skipped: [],
    });
    expect((await store.get('relay'))?.models).toEqual([EXISTING]);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.PROVIDERS_CHANGED);
    expectNoSecrets(result);
  });

  it('连接异常同样保留服务，异常消息中的秘密不会进入返回值', async () => {
    const ids = await scan();
    mocks.fetch.mockRejectedValue(new Error(`proxy failed ${KEY} https://host/${URL_SECRET}`));
    const result = await importIds(ids);
    expect(result).toMatchObject({
      ok: true,
      imported: [{ models: { error: '连接或响应异常' } }],
    });
    expect((await store.get('relay'))?.models).toEqual([EXISTING]);
    expectNoSecrets(result);
  });

  it('缺少 key 时不发请求，模型合并写盘失败时也保留已导入的服务', async () => {
    const ids = await scan([candidate('NoKey', { apiKey: undefined }), candidate()]);
    mocks.fetch.mockResolvedValue(reply());
    vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error(`disk ${KEY} ${URL_SECRET}`));
    const result = await importIds(ids);
    expect(result).toMatchObject({
      ok: true,
      imported: [
        { name: 'NoKey', models: { error: '还没有填写 API Key' } },
        { name: 'Relay', models: { error: '无法保存模型列表' } },
      ],
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((await store.list()).map(({ models }) => models)).toEqual([[EXISTING], [EXISTING]]);
    expectNoSecrets(result);
  });

  it('每个服务最多 15 秒：第一次请求耗时 10 秒后回退，第二次请求只剩 5 秒', async () => {
    const ids = await scan([candidate('Relay', { api: 'anthropic-messages' })]);
    vi.useFakeTimers();
    const firstStarted = Promise.withResolvers<void>();
    const first = Promise.withResolvers<Awaited<ReturnType<FetchLike>>>();
    const secondStarted = Promise.withResolvers<void>();
    let secondSignal: AbortSignal | undefined;
    mocks.fetch
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return first.promise;
      })
      .mockImplementationOnce((_url, { signal }) => {
        secondSignal = signal;
        secondStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      });
    const pending = importIds(ids);
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    first.resolve(reply({}, 404));
    await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondSignal?.aborted).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(secondSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      imported: [{ models: { error: '请求超时（15 秒）' } }],
    });
    expect((await store.get('relay'))?.models).toEqual([EXISTING]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expectNoSecrets(result);
  });

  it('响应体挂起也按时返回；忽略 abort 后迟到的列表不会再写盘', async () => {
    const ids = await scan();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const body = Promise.withResolvers<string>();
    mocks.fetch.mockImplementation(async () => ({
      ...reply(),
      text: () => {
        started.resolve();
        return body.promise;
      },
    }));
    const pending = importIds(ids);
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      imported: [{ models: { error: '请求超时（15 秒）' } }],
    });
    body.resolve(JSON.stringify({ data: [{ id: 'late-model' }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.get('relay'))?.models).toEqual([EXISTING]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expectNoSecrets(result);
  });

  it('最多 3 个服务同时拉取，完成一个才启动下一个，失败不阻塞其余服务且摘要保持导入顺序', async () => {
    const ids = await scan(Array.from({ length: 7 }, (_, i) => candidate(`Relay-${i}`)));
    const pending: Array<ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<FetchLike>>>>> =
      [];
    let active = 0;
    let maxActive = 0;
    mocks.fetch.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const request = Promise.withResolvers<Awaited<ReturnType<FetchLike>>>();
      pending.push(request);
      try {
        return await request.promise;
      } finally {
        active -= 1;
      }
    });
    const resultPromise = importIds(ids);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(mocks.send).not.toHaveBeenCalled();
    for (const [completed, index] of [1, 0, 2, 3, 4, 5, 6].entries()) {
      pending[index]?.resolve(index === 1 ? reply({}, 401) : reply());
      await vi.waitFor(() => expect(pending).toHaveLength(Math.min(7, completed + 4)));
    }
    const result = await resultPromise;
    expect(result.ok && result.imported.map(({ name }) => name)).toEqual(
      Array.from({ length: 7 }, (_, i) => `Relay-${i}`)
    );
    expect(result.ok && result.imported.filter(({ models }) => 'error' in models)).toHaveLength(1);
    expect((await store.list()).filter(({ models }) => models.length === 2)).toHaveLength(6);
    expect(maxActive).toBe(3);
    expect(active).toBe(0);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.PROVIDERS_CHANGED);
    expectNoSecrets(result);
  });

  it('非法入参和跳过的重复服务不触发拉取或广播', async () => {
    const ids = await scan();
    expect(
      await invoke(IPC_CHANNELS.PROVIDERS_IMPORT, { candidateIds: ids, apiKey: KEY })
    ).toMatchObject({ ok: false });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(reply({ data: [] }));
    expect(await importIds(ids)).toMatchObject({
      ok: true,
      imported: [{ models: { added: 0, total: 1 } }],
    });
    mocks.fetch.mockClear();
    mocks.send.mockClear();
    const duplicate = await importIds(ids);
    expect(duplicate).toMatchObject({ ok: true, imported: [], skipped: [{ name: 'Relay' }] });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expectNoSecrets(duplicate);
  });
});
