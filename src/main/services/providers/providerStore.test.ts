import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';
import {
  createProviderStore,
  parseStoredProvider,
  type StoredProvider,
  toProviderView,
} from './providerStore';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-providers-'));
  filePath = join(dir, 'providers.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const anthropic: ProviderUpsertInput = {
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true }],
  apiKey: 'sk-ant-secret-1234',
};

const readDisk = () => JSON.parse(readFileSync(filePath, 'utf8'));

describe('createProviderStore', () => {
  it('新建时按名称生成 id，key 明文写进 providers.json', async () => {
    const store = createProviderStore({ filePath });
    const result = await store.upsert(anthropic);
    expect(result).toEqual({
      ok: true,
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
        api: 'anthropic-messages',
        enabled: true,
        models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true }],
        apiKey: 'sk-ant-secret-1234',
      },
    });
    expect(readDisk().providers[0].apiKey).toBe('sk-ant-secret-1234');
    expect(await store.get('anthropic')).toMatchObject({ apiKey: 'sk-ant-secret-1234' });
  });

  it('同名服务的 id 加后缀；纯中文名回落为 provider', async () => {
    const store = createProviderStore({ filePath });
    await store.upsert(anthropic);
    expect(await store.upsert(anthropic)).toMatchObject({ provider: { id: 'anthropic-2' } });
    expect(
      await store.upsert({ ...anthropic, name: '公司中转', api: 'openai-completions' })
    ).toMatchObject({ provider: { id: 'provider' } });
  });

  it('更新：apiKey 缺省保留、给字符串替换、null 清除', async () => {
    const store = createProviderStore({ filePath });
    await store.upsert(anthropic);
    const { apiKey: _omit, ...withoutKey } = anthropic;

    await store.upsert({ ...withoutKey, id: 'anthropic', name: 'Claude', enabled: false });
    expect(await store.get('anthropic')).toMatchObject({
      name: 'Claude',
      enabled: false,
      apiKey: 'sk-ant-secret-1234',
    });

    await store.upsert({ ...withoutKey, id: 'anthropic', apiKey: 'sk-ant-rotated-9999' });
    expect((await store.get('anthropic'))?.apiKey).toBe('sk-ant-rotated-9999');

    await store.upsert({ ...withoutKey, id: 'anthropic', apiKey: null });
    expect(await store.get('anthropic')).not.toHaveProperty('apiKey');
    expect(readDisk().providers[0]).not.toHaveProperty('apiKey');
  });

  it('更新不存在的 id 返回错误且不写盘', async () => {
    const store = createProviderStore({ filePath });
    expect(await store.upsert({ ...anthropic, id: 'ghost' })).toMatchObject({ ok: false });
    expect(await store.list()).toEqual([]);
  });

  it('remove 按 id 删除，id 不存在返回 false', async () => {
    const store = createProviderStore({ filePath });
    await store.upsert(anthropic);
    expect(await store.remove('ghost')).toBe(false);
    expect(await store.remove('anthropic')).toBe(true);
    expect(readDisk().providers).toEqual([]);
  });
});

describe('toProviderView', () => {
  const stored: StoredProvider = {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://relay.example.com',
    enabled: true,
    models: [],
    apiKey: 'sk-ant-secret-1234',
  };

  it('去掉 key，只给 hasApiKey 与末 4 位', () => {
    const view = toProviderView(stored);
    expect(view).toEqual({
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example.com',
      enabled: true,
      models: [],
      hasApiKey: true,
      apiKeyHint: '1234',
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('没有 key 时 hasApiKey 为 false；过短的 key 不给 hint', () => {
    const { apiKey: _omit, ...noKey } = stored;
    expect(toProviderView(noKey)).toMatchObject({ hasApiKey: false });
    expect(toProviderView(noKey)).not.toHaveProperty('apiKeyHint');
    const short = toProviderView({ ...stored, apiKey: 'abc123' });
    expect(short).toMatchObject({ hasApiKey: true });
    expect(short).not.toHaveProperty('apiKeyHint');
  });

  it('返回的 models 是副本', () => {
    const source: StoredProvider = { ...stored, models: [{ id: 'm', name: 'M' }] };
    const view = toProviderView(source);
    view.models.push({ id: 'x', name: 'X' });
    expect(source.models).toHaveLength(1);
  });
});

describe('parseStoredProvider', () => {
  it('宽松收窄磁盘记录：丢掉非法模型与未知字段', () => {
    expect(
      parseStoredProvider({
        id: 'openai',
        name: 'OpenAI',
        api: 'openai-responses',
        enabled: true,
        apiKey: 'sk-1',
        extra: 1,
        models: [
          { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxOutput: -1, junk: true },
          { name: 'no id' },
          { id: 'bare' },
        ],
      })
    ).toEqual({
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-responses',
      enabled: true,
      models: [
        { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000 },
        { id: 'bare', name: 'bare' },
      ],
      apiKey: 'sk-1',
    });
  });

  it.each([
    null,
    'x',
    { name: 'A', api: 'anthropic-messages', enabled: true, models: [] },
    { id: 'Bad Id', name: 'A', api: 'anthropic-messages', enabled: true, models: [] },
    { id: 'a', name: '', api: 'anthropic-messages', enabled: true, models: [] },
    { id: 'a', name: 'A', api: 'ollama', enabled: true, models: [] },
  ])('缺 id / 名称 / 合法协议的记录丢弃：%j', (raw) => {
    expect(parseStoredProvider(raw)).toBeNull();
  });
});
