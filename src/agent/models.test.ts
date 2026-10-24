import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelRegistry,
  createWorkerModelRuntime,
  MODEL_PROVIDER_PREFIX,
  providerKey,
} from './models';

// 真实的 pi ModelRuntime（目录内置，不联网）；只注册 provider，不发请求
let agentDir = '';
let runtime: ModelRuntime;

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'fynvra-agent-models-'));
  runtime = await createWorkerModelRuntime(agentDir);
});

afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

const apiKeyOf = async (model: Parameters<ModelRuntime['getAuth']>[0]) =>
  (await runtime.getAuth(model))?.auth.apiKey;

describe('createModelRegistry', () => {
  it('registers a catalog model under a hashed provider and keeps the literal key in memory', async () => {
    const registry = createModelRegistry(runtime);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: key 里的字面 ${...} 正是要验证的输入
    const apiKey = 'sk-$HOME-${PATH}-!echo';
    const resolved = await registry.resolve({
      providerId: 'anthropic',
      api: 'anthropic-messages',
      apiKey,
      modelId: 'claude-sonnet-5-5',
      thinking: 'high',
    });

    expect(resolved.runtime).toBe(runtime);
    expect(resolved.thinking).toBe('high');
    expect(resolved.model).toMatchObject({
      id: 'claude-sonnet-5-5',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      provider: providerKey('anthropic-messages', 'https://api.anthropic.com', apiKey),
      reasoning: true,
      contextWindow: 1_000_000,
    });
    expect(resolved.model.provider.startsWith(MODEL_PROVIDER_PREFIX)).toBe(true);
    expect(resolved.model.provider).not.toContain('sk-');
    // `$VAR` 与 `!cmd` 原样当作 key，不经 pi 的配置值解析
    expect(await apiKeyOf(resolved.model)).toBe(apiKey);
    expect(await readFile(join(agentDir, 'auth.json'), 'utf8').catch(() => '')).not.toContain(
      'sk-'
    );
  });

  it('keeps different keys apart and accumulates models of the same provider', async () => {
    const registry = createModelRegistry(runtime);
    const base = { providerId: 'openai', api: 'openai-responses' };
    const first = await registry.resolve({ ...base, apiKey: 'key-a', modelId: 'gpt-5.5' });
    const second = await registry.resolve({ ...base, apiKey: 'key-b', modelId: 'gpt-5.5' });
    const sibling = await registry.resolve({ ...base, apiKey: 'key-a', modelId: 'gpt-5.4' });

    expect(first.model.provider).not.toBe(second.model.provider);
    expect(sibling.model.provider).toBe(first.model.provider);
    expect(first.model.baseUrl).toBe('https://api.openai.com/v1');
    expect(await apiKeyOf(first.model)).toBe('key-a');
    expect(await apiKeyOf(second.model)).toBe('key-b');
    expect(runtime.getModel(first.model.provider, 'gpt-5.5')).toBeDefined();
    expect(runtime.getModel(first.model.provider, 'gpt-5.4')).toBeDefined();
  });

  it('uses the spec base URL and conservative limits for models the catalog does not know', async () => {
    const registry = createModelRegistry(runtime);
    const { model } = await registry.resolve({
      providerId: 'local-proxy',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'local',
      modelId: 'my-local-model',
    });
    expect(model).toMatchObject({
      id: 'my-local-model',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 32_000,
    });
  });

  it('fails when an unknown api has no base URL', async () => {
    const registry = createModelRegistry(runtime);
    await expect(
      registry.resolve({ providerId: 'x', api: 'mystery-api', modelId: 'm', apiKey: 'k' })
    ).rejects.toThrow(/no base URL/);
  });
});
