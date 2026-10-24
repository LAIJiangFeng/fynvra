import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRegistry, createWorkerModelRuntime } from './models';

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

// Main 的 createModelResolver 给出的运行时 provider 键：fynvra- + sha256(baseUrl + key) 前 16 位
const KEY_A = 'fynvra-00000000000000aa';
const KEY_B = 'fynvra-00000000000000bb';

describe('createModelRegistry', () => {
  it('registers a catalog model under the provider key from Main and keeps the literal key in memory', async () => {
    const registry = createModelRegistry(runtime);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: key 里的字面 ${...} 正是要验证的输入
    const apiKey = 'sk-$HOME-${PATH}-!echo';
    const resolved = await registry.resolve({
      providerId: KEY_A,
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey,
      modelId: 'claude-sonnet-5-5',
      thinking: 'high',
    });

    expect(resolved.runtime).toBe(runtime);
    expect(resolved.thinking).toBe('high');
    // 能力（上下文、thinking）取 pi 目录里同 id 同 api 的模型
    expect(resolved.model).toMatchObject({
      id: 'claude-sonnet-5-5',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      provider: KEY_A,
      reasoning: true,
      contextWindow: 1_000_000,
    });
    // `$VAR` 与 `!cmd` 原样当作 key，不经 pi 的配置值解析
    expect(await apiKeyOf(resolved.model)).toBe(apiKey);
    expect(await readFile(join(agentDir, 'auth.json'), 'utf8').catch(() => '')).not.toContain(
      'sk-'
    );
  });

  it('accumulates models of one provider key and keeps different keys apart', async () => {
    const registry = createModelRegistry(runtime);
    const base = { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' };
    const first = await registry.resolve({
      ...base,
      providerId: KEY_A,
      apiKey: 'key-a',
      modelId: 'gpt-5.5',
    });
    const other = await registry.resolve({
      ...base,
      providerId: KEY_B,
      apiKey: 'key-b',
      modelId: 'gpt-5.5',
    });
    const sibling = await registry.resolve({
      ...base,
      providerId: KEY_A,
      apiKey: 'key-a',
      modelId: 'gpt-5.4',
    });

    expect([first.model.provider, other.model.provider, sibling.model.provider]).toEqual([
      KEY_A,
      KEY_B,
      KEY_A,
    ]);
    expect(await apiKeyOf(first.model)).toBe('key-a');
    expect(await apiKeyOf(other.model)).toBe('key-b');
    // registerProvider 整体替换模型列表：后注册的 gpt-5.4 不能挤掉 gpt-5.5
    expect(runtime.getModel(KEY_A, 'gpt-5.5')).toBeDefined();
    expect(runtime.getModel(KEY_A, 'gpt-5.4')).toBeDefined();
  });

  it('builds models the catalog does not know from the spec fields and conservative defaults', async () => {
    const registry = createModelRegistry(runtime);
    const { model } = await registry.resolve({
      providerId: KEY_A,
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'local',
      modelId: 'my-local-model',
    });
    expect(model).toMatchObject({
      id: 'my-local-model',
      name: 'my-local-model',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      provider: KEY_A,
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 32_000,
    });
  });

  it('falls back to the official endpoint of the api when the spec has no base URL', async () => {
    const registry = createModelRegistry(runtime);
    const { model } = await registry.resolve({
      providerId: KEY_B,
      api: 'anthropic-messages',
      apiKey: 'k',
      modelId: 'claude-haiku-5-5',
    });
    expect(model.baseUrl).toBe('https://api.anthropic.com');
  });

  it('fails when an unknown api has no base URL', async () => {
    const registry = createModelRegistry(runtime);
    await expect(
      registry.resolve({ providerId: KEY_A, api: 'mystery-api', modelId: 'm', apiKey: 'k' })
    ).rejects.toThrow(/no base URL/);
  });

  it('refuses provider keys outside the fynvra- namespace instead of replacing a built-in pi provider', async () => {
    const registry = createModelRegistry(runtime);
    const catalogBefore = runtime.getModels().filter((model) => model.provider === 'anthropic');
    await expect(
      registry.resolve({
        providerId: 'anthropic',
        api: 'anthropic-messages',
        apiKey: 'k',
        modelId: 'claude-sonnet-5-5',
      })
    ).rejects.toThrow(/runtime provider key/);
    expect(runtime.getModels().filter((model) => model.provider === 'anthropic')).toEqual(
      catalogBefore
    );
  });
});
