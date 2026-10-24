import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelQuery } from '@shared/types/agent';
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

describe('createModelRegistry thinking levels', () => {
  const levelsOf = (query: ModelQuery) => createModelRegistry(runtime).describe(query);

  it('gives each catalog model exactly the levels pi offers for it (no uniform six levels)', () => {
    const anthropic = (modelId: string) => levelsOf({ api: 'anthropic-messages', modelId });
    // pi 1.4.0 目录：opus / sonnet 5.5 的 off、minimal 映射为 null，haiku 5.5 只有 minimal 为 null
    expect(anthropic('claude-opus-5-5')).toEqual({
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    });
    expect(anthropic('claude-sonnet-5-5').thinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(anthropic('claude-haiku-5-5').thinkingLevels).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(anthropic('claude-fable-5-1').thinkingLevels).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    // 没有 xhigh 映射的老模型：pi 只在显式映射时提供 xhigh
    expect(anthropic('claude-opus-4-5').thinkingLevels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    const google = (modelId: string) => levelsOf({ api: 'google-generative-ai', modelId });
    expect(google('gemini-pro-latest').thinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(google('gemini-flash-latest').thinkingLevels).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('maps OpenAI models with the official openai provider entry, not the first gateway that lists the id', () => {
    const openai = (modelId: string) => levelsOf({ api: 'openai-responses', modelId });
    // cloudflare-ai-gateway 排在 openai 前面，它的 gpt-5.5 没有 off；官方 openai 的 off 映射为 "none"
    expect(openai('gpt-5.5').thinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    // pi 另有 max 档位，fynvra 的 ThinkingLevel 没有它
    expect(openai('gpt-6.1-sol')).toEqual({
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    });
  });

  it('has no levels for models without reasoning', () => {
    expect(levelsOf({ api: 'openai-responses', modelId: 'gpt-4.1' })).toEqual({
      thinkingLevels: [],
    });
    expect(levelsOf({ api: 'openai-completions', modelId: 'my-local-model' })).toEqual({
      thinkingLevels: [],
    });
  });

  it('uses the reasoning flag from settings only for models the catalog does not know', () => {
    expect(
      levelsOf({ api: 'openai-completions', modelId: 'qwen3-coder-local', reasoning: true })
    ).toEqual({
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      defaultThinking: 'medium',
    });
    // 目录里有的模型以目录为准：标记改不了它的能力
    expect(levelsOf({ api: 'openai-responses', modelId: 'gpt-4.1', reasoning: true })).toEqual({
      thinkingLevels: [],
    });
    expect(
      levelsOf({ api: 'anthropic-messages', modelId: 'claude-opus-5-5', reasoning: false })
        .thinkingLevels
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('registers the same template it describes, so the levels shown are the levels pi accepts', async () => {
    const registry = createModelRegistry(runtime);
    const queries: ModelQuery[] = [
      { api: 'anthropic-messages', modelId: 'claude-opus-5-5' },
      { api: 'anthropic-messages', modelId: 'claude-haiku-5-5' },
      { api: 'openai-responses', modelId: 'gpt-5.5' },
      { api: 'google-generative-ai', modelId: 'gemini-flash-latest' },
      { api: 'openai-completions', modelId: 'qwen3-coder-local', reasoning: true },
      { api: 'openai-completions', modelId: 'plain-local' },
    ];
    for (const query of queries) {
      const { model } = await registry.resolve({
        ...query,
        providerId: KEY_A,
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'k',
      });
      const accepted = model.reasoning
        ? getSupportedThinkingLevels(model).filter((level) => level !== 'max')
        : [];
      expect(registry.describe(query).thinkingLevels).toEqual(accepted);
    }
    // 官方 openai 条目的上下文是 272k（网关条目写的是 1M），与设置页模板一致
    expect(runtime.getModel(KEY_A, 'gpt-5.5')?.contextWindow).toBe(272_000);
  });

  it("applies the requested level when the model offers it, otherwise the model's default", async () => {
    const registry = createModelRegistry(runtime);
    const resolve = (modelId: string, thinking?: 'off' | 'xhigh' | 'high') =>
      registry.resolve({
        providerId: KEY_B,
        api: 'anthropic-messages',
        apiKey: 'k',
        modelId,
        ...(thinking ? { thinking } : {}),
      });
    expect((await resolve('claude-opus-5-5', 'xhigh')).thinking).toBe('xhigh');
    // opus 5.5 没有 off：回落到默认档位（pi 自己 clamp 会就近取 low）
    expect((await resolve('claude-opus-5-5', 'off')).thinking).toBe('medium');
    expect((await resolve('claude-haiku-5-5', 'off')).thinking).toBe('off');
    expect((await resolve('claude-opus-5-5')).thinking).toBe('medium');
    const plain = await registry.resolve({
      providerId: KEY_B,
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      modelId: 'plain-local',
      thinking: 'high',
    });
    expect(plain.thinking).toBeUndefined();
  });
});
