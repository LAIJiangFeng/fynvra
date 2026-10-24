import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@fynvra/core';
import type { ModelQuery } from '@shared/types/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelRegistry,
  createWorkerModelRuntime,
  findClosestModel,
  normalizeModelId,
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
  const anthropic = (modelId: string, reasoning?: boolean) =>
    levelsOf({ api: 'anthropic-messages', modelId, ...(reasoning ? { reasoning } : {}) });
  const openai = (modelId: string, reasoning?: boolean) =>
    levelsOf({ api: 'openai-responses', modelId, ...(reasoning ? { reasoning } : {}) });
  const google = (modelId: string, reasoning?: boolean) =>
    levelsOf({ api: 'google-generative-ai', modelId, ...(reasoning ? { reasoning } : {}) });
  /** pi 目录里这个条目自己的档位（getSupportedThinkingLevels） */
  const piLevelsOf = (provider: string, id: string) => {
    const model = runtime.getModels().find((m) => m.provider === provider && m.id === id);
    if (!model) throw new Error(`${provider}/${id} is missing from the pi catalog`);
    return getSupportedThinkingLevels(model);
  };

  it('gives each catalog model exactly the levels pi offers for it, max included', () => {
    // pi 1.4.0 目录（总结里贴了完整输出）
    expect(anthropic('claude-fable-5-1')).toEqual({
      thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinking: 'medium',
      source: 'catalog',
    });
    // opus / sonnet 5.5 的 off、minimal 映射为 null
    expect(anthropic('claude-opus-5-5').thinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(anthropic('claude-sonnet-5-5').thinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(anthropic('claude-haiku-5-5').thinkingLevels).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(anthropic('claude-opus-4-8').thinkingLevels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // sonnet 4.6 只映射了 max：没有 xhigh
    expect(anthropic('claude-sonnet-4-6').thinkingLevels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'max',
    ]);
    // 没有 xhigh / max 映射的老模型：pi 只在显式映射时提供这两档
    expect(anthropic('claude-opus-4-5').thinkingLevels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(google('gemini-pro-latest').thinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(google('gemini-flash-latest').thinkingLevels).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('maps OpenAI models with the official openai provider entry, not the first gateway that lists the id', () => {
    // cloudflare-ai-gateway 排在 openai 前面，它的 gpt-5.5 没有 off；官方 openai 的 off 映射为 "none"、max 为 null
    expect(openai('gpt-5.5')).toEqual({
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
      source: 'catalog',
    });
    expect(openai('gpt-5.6-sol').thinkingLevels).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(openai('gpt-6-sol').thinkingLevels).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(openai('gpt-6-astra').thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(openai('gpt-6.1-sol').thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('has no levels for models without reasoning', () => {
    expect(openai('gpt-4.1')).toEqual({ thinkingLevels: [], source: 'catalog' });
    expect(levelsOf({ api: 'openai-completions', modelId: 'my-local-model' })).toEqual({
      thinkingLevels: [],
      source: 'fallback',
    });
  });

  describe('models the catalog does not list: the closest catalog model of the same api', () => {
    it('lowercases the id', () => {
      expect(anthropic('Claude-Fable-5-1')).toEqual({
        thinkingLevels: piLevelsOf('anthropic', 'claude-fable-5-1'),
        defaultThinking: 'medium',
        source: 'inferred:claude-fable-5-1',
      });
    });

    it('drops bracketed tags such as [1m]', () => {
      expect(anthropic('claude-opus-4-8[1m]')).toMatchObject({
        thinkingLevels: piLevelsOf('anthropic', 'claude-opus-4-8'),
        source: 'inferred:claude-opus-4-8',
      });
    });

    it('drops date suffixes (YYYYMMDD, YYYY-MM-DD, MM-YYYY) and -latest / -preview', () => {
      expect(anthropic('claude-opus-5-5-20261001')).toMatchObject({
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'inferred:claude-opus-5-5',
      });
      expect(openai('gpt-5.6-sol-2026-09-01')).toMatchObject({
        thinkingLevels: piLevelsOf('openai', 'gpt-5.6-sol'),
        source: 'inferred:gpt-5.6-sol',
      });
      expect(anthropic('claude-haiku-5-5-latest').source).toBe('inferred:claude-haiku-5-5');
      // 目录里的 id 同样规整：gemini-3.1-pro-preview → gemini-3.1-pro
      expect(google('gemini-3.1-pro-preview-06-2026')).toMatchObject({
        thinkingLevels: ['low', 'medium', 'high'],
        source: 'inferred:gemini-3.1-pro-preview',
      });
    });

    it('matches a variant such as -sol as a whole segment, then backs off one segment at a time', () => {
      // 目录里没有 gpt-5.6，只有 gpt-5.6-luna / -sol / -terra：退到「gpt-5.6」这一段就找到了
      expect(openai('gpt-5.6')).toMatchObject({
        thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        source: expect.stringMatching(/^inferred:gpt-5\.6-(luna|sol|terra)$/),
      });
      // 6.2 不在目录里：退到「gpt-6」，下一段版本号最近的是 gpt-6.1-sol
      expect(openai('gpt-6.2-sol')).toMatchObject({
        thinkingLevels: piLevelsOf('openai', 'gpt-6.1-sol'),
        source: 'inferred:gpt-6.1-sol',
      });
      // 新出的小版本按最近的版本推断：opus 4.9 → 4.8；opus 4.0 → 4.5（老一代，没有 xhigh / max）
      expect(anthropic('claude-opus-4-9').source).toBe('inferred:claude-opus-4-8');
      expect(anthropic('claude-opus-4-0')).toMatchObject({
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
        source: 'inferred:claude-opus-4-5',
      });
    });

    it('takes the reasoning of the catalog model it matched, whatever the flag says', () => {
      // gpt-4o 不推理：推断出来也不显示档位
      expect(openai('gpt-4o-2024-12-17', true)).toEqual({
        thinkingLevels: [],
        source: 'inferred:gpt-4o',
      });
      expect(
        levelsOf({ api: 'anthropic-messages', modelId: 'claude-opus-4-8[1m]', reasoning: false })
      ).toEqual(anthropic('claude-opus-4-8[1m]'));
    });

    it('does not count a shared family name alone, and never looks at another api', () => {
      // 只共享「gpt」：不算接近，按协议兜底（没标推理就没有档位）
      expect(openai('gpt-7-sol')).toEqual({ thinkingLevels: [], source: 'fallback' });
      expect(openai('gpt-oss-120b')).toEqual({ thinkingLevels: [], source: 'fallback' });
      // 目录里 gpt-6.1-sol 只在 openai-responses 下：openai-completions 的同名模型不借它的档位
      expect(levelsOf({ api: 'openai-completions', modelId: 'gpt-6.1-sol' }).source).toBe(
        'fallback'
      );
    });
  });

  describe('falling back by protocol when nothing in the catalog is close', () => {
    it("gives an Anthropic model marked as reasoning pi's levels for the current Claude generation", () => {
      expect(anthropic('glm-4.7', true)).toEqual({
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultThinking: 'medium',
        source: 'fallback',
      });
      expect(anthropic('glm-4.7', true).thinkingLevels).toEqual(
        piLevelsOf('anthropic', 'claude-opus-5-5')
      );
    });

    it('gives an OpenAI model marked as reasoning low / medium / high / xhigh, on both OpenAI apis', () => {
      const levels = ['low', 'medium', 'high', 'xhigh'];
      expect(openai('gpt-7-sol', true)).toEqual({
        thinkingLevels: levels,
        defaultThinking: 'medium',
        source: 'fallback',
      });
      expect(
        levelsOf({ api: 'openai-completions', modelId: 'qwen3-coder-local', reasoning: true })
          .thinkingLevels
      ).toEqual(levels);
    });

    it('gives a Google model marked as reasoning the levels of the newest Gemini in the catalog', () => {
      // pi 1.4.0 里版本号最大的是 gemini-4-argon
      expect(google('gemini-5-flash', true)).toEqual({
        thinkingLevels: piLevelsOf('google', 'gemini-4-argon'),
        defaultThinking: 'medium',
        source: 'fallback',
      });
    });

    it("keeps pi's default set for an api without a fallback, and no levels without the reasoning flag", () => {
      expect(
        levelsOf({ api: 'mystery-api', modelId: 'm', reasoning: true }).thinkingLevels
      ).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
      expect(anthropic('glm-4.7')).toEqual({ thinkingLevels: [], source: 'fallback' });
      // 目录里有的模型以目录为准：标记改不了它的能力
      expect(openai('gpt-4.1', true)).toEqual({ thinkingLevels: [], source: 'catalog' });
      expect(
        levelsOf({ api: 'anthropic-messages', modelId: 'claude-opus-5-5', reasoning: false })
          .thinkingLevels
      ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });
  });

  it('registers the same definition it describes, so the levels shown are the levels pi accepts', async () => {
    const registry = createModelRegistry(runtime);
    const queries: ModelQuery[] = [
      { api: 'anthropic-messages', modelId: 'claude-opus-5-5' },
      { api: 'anthropic-messages', modelId: 'claude-haiku-5-5' },
      { api: 'anthropic-messages', modelId: 'claude-fable-5-1' },
      { api: 'anthropic-messages', modelId: 'claude-opus-4-8[1m]' },
      { api: 'anthropic-messages', modelId: 'glm-4.7', reasoning: true },
      { api: 'openai-responses', modelId: 'gpt-5.5' },
      { api: 'openai-responses', modelId: 'gpt-6.2-sol' },
      { api: 'openai-responses', modelId: 'gpt-7-sol', reasoning: true },
      { api: 'google-generative-ai', modelId: 'gemini-flash-latest' },
      { api: 'google-generative-ai', modelId: 'gemini-5-flash', reasoning: true },
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
      const accepted = model.reasoning ? getSupportedThinkingLevels(model) : [];
      expect(registry.describe(query).thinkingLevels, query.modelId).toEqual(accepted);
    }
    // 官方 openai 条目的上下文是 272k（网关条目写的是 1M），与设置页模板一致
    expect(runtime.getModel(KEY_A, 'gpt-5.5')?.contextWindow).toBe(272_000);
  });

  it("registers an inferred model under the user's id with the matched model's capabilities", async () => {
    const { model } = await createModelRegistry(runtime).resolve({
      providerId: KEY_B,
      api: 'anthropic-messages',
      apiKey: 'k',
      modelId: 'claude-opus-4-8[1m]',
      thinking: 'max',
    });
    // 请求里仍是中转认的 id；max 要靠 forceAdaptiveThinking 才会作为 effort 发出去
    expect(model).toMatchObject({
      id: 'claude-opus-4-8[1m]',
      name: 'claude-opus-4-8[1m]',
      reasoning: true,
      contextWindow: 1_000_000,
      compat: { forceAdaptiveThinking: true },
    });
    // 目录外又推断不出的模型：保守上限，不带别的模型的兼容开关
    const { model: unknown } = await createModelRegistry(runtime).resolve({
      providerId: KEY_B,
      api: 'anthropic-messages',
      apiKey: 'k',
      modelId: 'glm-4.7',
      reasoning: true,
    });
    expect(unknown).toMatchObject({ id: 'glm-4.7', contextWindow: 128_000, maxTokens: 32_000 });
    expect(unknown.compat).toBeUndefined();
  });

  it("applies the requested level when the model offers it, otherwise the model's default", async () => {
    const registry = createModelRegistry(runtime);
    const resolve = (modelId: string, thinking?: ThinkingLevel, api = 'anthropic-messages') =>
      registry.resolve({
        providerId: KEY_B,
        api,
        apiKey: 'k',
        modelId,
        ...(thinking ? { thinking } : {}),
      });
    expect((await resolve('claude-opus-5-5', 'xhigh')).thinking).toBe('xhigh');
    expect((await resolve('claude-fable-5-1', 'max')).thinking).toBe('max');
    expect((await resolve('claude-opus-4-8[1m]', 'max')).thinking).toBe('max');
    // gpt-5.5 没有 max：回落到默认档位，不是就近的 xhigh
    expect((await resolve('gpt-5.5', 'max', 'openai-responses')).thinking).toBe('medium');
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

describe('normalizeModelId', () => {
  it.each([
    ['lowercases', 'Claude-Opus-4-8', 'claude-opus-4-8'],
    ['drops bracketed tags', 'claude-opus-4-8[1m]', 'claude-opus-4-8'],
    ['drops bracketed tags with spaces around', 'gpt-6-astra [beta] ', 'gpt-6-astra'],
    ['drops a YYYYMMDD date', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['drops a YYYY-MM-DD date', 'gpt-4o-2024-08-06', 'gpt-4o'],
    ['drops an MM-YYYY date', 'deep-research-preview-04-2026', 'deep-research'],
    ['drops an MM-DD date', 'gemini-2.5-pro-preview-06-05', 'gemini-2.5-pro'],
    ['drops a four-digit date', 'deepseek-r1-0528', 'deepseek-r1'],
    ['drops -latest', 'claude-haiku-5-5-latest', 'claude-haiku-5-5'],
    ['drops -preview', 'gemini-3.1-pro-preview', 'gemini-3.1-pro'],
    [
      'keeps other suffixes',
      'gemini-3.1-pro-preview-customtools',
      'gemini-3.1-pro-preview-customtools',
    ],
    ['keeps three-digit versions', 'gemini-2.0-flash-001', 'gemini-2.0-flash-001'],
    ['keeps variants', 'gpt-5.6-sol', 'gpt-5.6-sol'],
  ])('%s', (_rule, id, normalized) => {
    expect(normalizeModelId(id)).toBe(normalized);
  });
});

describe('findClosestModel', () => {
  const entries = (...ids: string[]) => ids.map((id) => ({ id, provider: 'gateway' }));

  it('prefers the official provider among equally close entries', () => {
    const own = { id: 'claude-opus-5-5', provider: 'anthropic' };
    const gateway = { id: 'claude-opus-5-5', provider: 'gateway' };
    expect(findClosestModel([gateway, own], 'claude-opus-5-5-20261001', 'anthropic')).toBe(own);
    expect(findClosestModel([gateway], 'claude-opus-5-5-20261001', 'anthropic')).toBe(gateway);
  });

  it('prefers the closest version in the first segment that differs', () => {
    const list = entries('x-4-5', 'x-4-8');
    expect(findClosestModel(list, 'x-4-6')?.id).toBe('x-4-5');
    expect(findClosestModel(list, 'x-4-9')?.id).toBe('x-4-8');
  });

  it('then the entry with the fewest extra segments, then the newest', () => {
    expect(
      findClosestModel(entries('m-3.5-flash-lite', 'm-3.5-flash'), 'm-3.5-flash-001')?.id
    ).toBe('m-3.5-flash');
    expect(findClosestModel(entries('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'), 'gpt-6')?.id).toBe(
      'gpt-6-sol'
    );
    // 同一模型的别名与带日期的版本：取较短的别名
    expect(findClosestModel(entries('m-4-5-20251001', 'm-4-5'), 'm-4-5-20260101')?.id).toBe(
      'm-4-5'
    );
  });

  it('needs at least two shared segments', () => {
    expect(findClosestModel(entries('gpt-5', 'gpt-6-sol'), 'gpt-oss-120b')).toBeUndefined();
    expect(findClosestModel(entries('o3', 'o4-mini'), 'o5')).toBeUndefined();
    expect(findClosestModel(entries('gpt-6-sol'), 'gpt-6-nova')?.id).toBe('gpt-6-sol');
  });
});
