import { describe, expect, it } from 'vitest';
import { ENV_MODEL_SECRET_VARS, envModelResolver } from './envModelResolver';

describe('envModelResolver', () => {
  it('fails with a hint when no key is configured', async () => {
    const result = await envModelResolver({}).resolve(undefined);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('FYNVRA_ANTHROPIC_API_KEY'),
    });
    expect(!result.ok && result.error).toContain('FYNVRA_OPENAI_API_KEY');
  });

  it('picks the first provider with a key and its default model', async () => {
    const env = { FYNVRA_ANTHROPIC_API_KEY: '  sk-ant-1  ', FYNVRA_OPENAI_API_KEY: 'sk-oa-1' };
    await expect(envModelResolver(env).resolve(undefined)).resolves.toEqual({
      ok: true,
      model: {
        providerId: 'anthropic',
        api: 'anthropic-messages',
        apiKey: 'sk-ant-1',
        modelId: 'claude-sonnet-5-5',
      },
    });
    await expect(
      envModelResolver({ FYNVRA_OPENAI_API_KEY: 'sk-oa-1' }).resolve(undefined)
    ).resolves.toEqual({
      ok: true,
      model: {
        providerId: 'openai',
        api: 'openai-responses',
        apiKey: 'sk-oa-1',
        modelId: 'gpt-5.5',
      },
    });
  });

  it('honours an explicit model reference and an optional base URL', async () => {
    const env = {
      FYNVRA_ANTHROPIC_API_KEY: 'sk-ant-1',
      FYNVRA_ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      FYNVRA_OPENAI_BASE_URL: '   ',
      FYNVRA_OPENAI_API_KEY: 'sk-oa-1',
    };
    const resolver = envModelResolver(env);
    await expect(
      resolver.resolve({ providerId: 'anthropic', modelId: 'claude-opus-5-5' })
    ).resolves.toEqual({
      ok: true,
      model: {
        providerId: 'anthropic',
        api: 'anthropic-messages',
        apiKey: 'sk-ant-1',
        baseUrl: 'http://127.0.0.1:8787',
        modelId: 'claude-opus-5-5',
      },
    });
    const openai = await resolver.resolve({ providerId: 'openai', modelId: 'gpt-5.4' });
    expect(openai.ok && openai.model).not.toHaveProperty('baseUrl');
  });

  it('rejects a provider without a key and providers it does not know', async () => {
    const resolver = envModelResolver({ FYNVRA_ANTHROPIC_API_KEY: 'sk-ant-1' });
    await expect(resolver.resolve({ providerId: 'openai', modelId: 'gpt-5.5' })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('FYNVRA_OPENAI_API_KEY'),
    });
    await expect(resolver.resolve({ providerId: 'google', modelId: 'gemini' })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('google'),
    });
  });

  it('lists the variables that must stay in Main', () => {
    expect(ENV_MODEL_SECRET_VARS).toEqual(['FYNVRA_ANTHROPIC_API_KEY', 'FYNVRA_OPENAI_API_KEY']);
  });
});
