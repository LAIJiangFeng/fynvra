import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
  net: { fetch: mocks.fetch },
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const KEY = 'sk-ant-api03-very-secret-key-7890';
const input = {
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
  apiKey: KEY,
};

beforeAll(async () => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'fynvra-ipc-providers-'));
  const { registerProviderHandlers } = await import('./providers');
  registerProviderHandlers();
});

afterAll(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.send.mockClear();
  mocks.fetch.mockReset();
});

describe('providers IPC', () => {
  it('非法入参被拒绝，不写盘也不广播', async () => {
    for (const raw of [null, { ...input, api: 'ollama' }, { ...input, extra: true }]) {
      expect(await invoke(IPC_CHANNELS.PROVIDERS_UPSERT, raw)).toMatchObject({ ok: false });
    }
    expect(await invoke(IPC_CHANNELS.PROVIDERS_LIST)).toEqual({ ok: true, providers: [] });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('保存后 providers.json 里有 key，upsert / list 的返回里没有', async () => {
    const saved = await invoke(IPC_CHANNELS.PROVIDERS_UPSERT, input);
    expect(saved).toMatchObject({
      ok: true,
      provider: { id: 'anthropic', hasApiKey: true, apiKeyHint: '7890' },
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.PROVIDERS_CHANGED);

    const disk = readFileSync(join(mocks.userData, 'providers.json'), 'utf8');
    expect(disk).toContain(KEY);
    const listed = await invoke(IPC_CHANNELS.PROVIDERS_LIST);
    expect(listed).toMatchObject({ ok: true, providers: [{ id: 'anthropic' }] });
    expect(JSON.stringify(listed)).not.toContain(KEY);
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });

  it('test 只收 id，用已保存的 key 经 net.fetch 发列模型请求', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }),
    });
    expect(await invoke(IPC_CHANNELS.PROVIDERS_TEST, 'anthropic')).toMatchObject({
      ok: true,
      modelCount: 1,
    });
    const [url, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init.headers['x-api-key']).toBe(KEY);

    expect(await invoke(IPC_CHANNELS.PROVIDERS_TEST, { id: 'anthropic' })).toMatchObject({
      ok: false,
    });
    expect(await invoke(IPC_CHANNELS.PROVIDERS_TEST, 'ghost')).toEqual({
      ok: false,
      error: '模型服务不存在',
    });
  });

  it('编辑时不传 key 则保留，remove 按 id 删除并广播', async () => {
    const { apiKey: _omit, ...withoutKey } = input;
    await invoke(IPC_CHANNELS.PROVIDERS_UPSERT, { ...withoutKey, id: 'anthropic', name: 'Claude' });
    expect(readFileSync(join(mocks.userData, 'providers.json'), 'utf8')).toContain(KEY);

    expect(await invoke(IPC_CHANNELS.PROVIDERS_REMOVE, '../providers')).toMatchObject({
      ok: false,
    });
    expect(await invoke(IPC_CHANNELS.PROVIDERS_REMOVE, 'anthropic')).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenLastCalledWith(IPC_CHANNELS.PROVIDERS_CHANGED);
    expect(await invoke(IPC_CHANNELS.PROVIDERS_REMOVE, 'anthropic')).toEqual({
      ok: false,
      error: '模型服务不存在',
    });
  });
});
