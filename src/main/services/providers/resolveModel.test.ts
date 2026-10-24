import type { Role, ThinkingLevel } from '@fynvra/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ModelResolver } from '../agentHost/types';
import type { StoredProvider } from './providerStore';
import { createModelResolver, runtimeProviderId } from './resolveModel';

// ARCHITECTURE §9.5 原文（接口归 agent-host），用来钉住结构兼容：createModelResolver() 可直接注入
interface Spec95ResolvedModelSpec {
  providerId: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  thinking?: ThinkingLevel;
}
interface Spec95ModelResolver {
  resolve(ref: { providerId: string; modelId: string } | undefined): Promise<
    | {
        ok: true;
        model: Spec95ResolvedModelSpec;
        ref: { providerId: string; modelId: string };
      }
    | { ok: false; error: string }
  >;
}

const anthropic: StoredProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
  apiKey: 'sk-ant-secret',
};

const source = (providers: StoredProvider[]) => ({ list: async () => structuredClone(providers) });

describe('createModelResolver', () => {
  it('与 §9.5 的 ModelResolver 结构兼容，Role.model 可以直接当引用传入', () => {
    expectTypeOf(createModelResolver).returns.toExtend<Spec95ModelResolver>();
    expectTypeOf<NonNullable<Role['model']>>().toExtend<Parameters<ModelResolver['resolve']>[0]>();
  });

  it('按 providerId / modelId 解析出可跨进程传递的模型描述', async () => {
    const resolver = createModelResolver(source([anthropic]));
    const roleModel: NonNullable<Role['model']> = {
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      thinking: 'high',
    };
    const result = await resolver.resolve(roleModel);
    expect(result).toEqual({
      ok: true,
      model: {
        providerId: runtimeProviderId('https://api.anthropic.com', 'sk-ant-secret'),
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-secret',
        modelId: 'claude-opus-5-5',
        thinking: 'high',
      },
      ref: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    });
  });

  it('非法的 thinking 丢弃；Google 地址补 /v1beta', async () => {
    const google: StoredProvider = {
      ...anthropic,
      id: 'google',
      api: 'google-generative-ai',
      baseUrl: 'https://gemini.example.com/',
      models: [{ id: 'gemini-pro-latest', name: 'Gemini Pro' }],
    };
    const result = await createModelResolver(source([google])).resolve({
      providerId: 'google',
      modelId: 'gemini-pro-latest',
      thinking: 'turbo',
    } as never);
    expect(result).toMatchObject({
      ok: true,
      model: { baseUrl: 'https://gemini.example.com/v1beta' },
    });
    expect(result.ok && 'thinking' in result.model).toBe(false);
  });

  it('运行时 provider 键按 baseUrl + apiKey 去重，且不含 key 明文', async () => {
    const copy: StoredProvider = { ...anthropic, id: 'anthropic-2', name: 'Claude 副本' };
    const rotated: StoredProvider = { ...anthropic, id: 'anthropic-3', apiKey: 'sk-ant-other' };
    const resolver = createModelResolver(source([anthropic, copy, rotated]));
    const ref = (providerId: string) => ({ providerId, modelId: 'claude-opus-5-5' });
    const [a, b, c] = await Promise.all(
      ['anthropic', 'anthropic-2', 'anthropic-3'].map((id) => resolver.resolve(ref(id)))
    );
    const idOf = (result: typeof a) => (result?.ok ? result.model.providerId : '');
    expect(idOf(a)).toBe(idOf(b));
    expect(idOf(a)).not.toBe(idOf(c));
    expect(idOf(a)).toMatch(/^fynvra-[0-9a-f]{16}$/);
    expect(idOf(a)).not.toContain('secret');
  });

  it.each([
    ['服务不存在', { providerId: 'ghost', modelId: 'm' }, [anthropic]],
    [
      '服务已停用',
      { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
      [{ ...anthropic, enabled: false }],
    ],
    [
      '服务没有 key',
      { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
      [{ ...anthropic, apiKey: undefined }],
    ],
    ['服务里没有该模型', { providerId: 'anthropic', modelId: 'gpt-5.5' }, [anthropic]],
  ])('%s：返回可读错误', async (_label, ref, providers) => {
    const result = await createModelResolver(source(providers)).resolve(ref);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
  });

  it('不指定模型时取第一个启用、有 key、有模型的服务的第一个模型', async () => {
    const providers: StoredProvider[] = [
      { ...anthropic, id: 'off', enabled: false },
      { ...anthropic, id: 'nokey', apiKey: undefined },
      { ...anthropic, id: 'empty', models: [] },
      { ...anthropic, id: 'usable' },
    ];
    // ref 写明选中的是哪个服务：会话记下它，之后 spawn 时按同一个服务解析
    expect(await createModelResolver(source(providers)).resolve(undefined)).toMatchObject({
      ok: true,
      model: { modelId: 'claude-opus-5-5', apiKey: 'sk-ant-secret' },
      ref: { providerId: 'usable', modelId: 'claude-opus-5-5' },
    });
    expect(
      await createModelResolver(source(providers.slice(0, 3))).resolve(undefined)
    ).toMatchObject({ ok: false });
  });

  it('读取 providers.json 失败时返回错误而不是抛出', async () => {
    const broken = { list: () => Promise.reject(new Error('EACCES')) };
    expect(await createModelResolver(broken).resolve(undefined)).toMatchObject({ ok: false });
  });
});
