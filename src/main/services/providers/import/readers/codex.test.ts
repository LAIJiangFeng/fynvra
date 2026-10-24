import { describe, expect, it } from 'vitest';
import { codexAuthJson, codexConfigToml, KEYS } from '../fixtures';
import { readCodex, readCodexConfig } from './codex';

describe('readCodex', () => {
  it('本机格式：model_provider 选中的自定义服务，wire_api responses，key 来自 auth.json', () => {
    expect(readCodex({ config: codexConfigToml, auth: codexAuthJson, env: {} })).toEqual({
      providers: [
        {
          source: 'codex',
          sourceLabel: 'Codex',
          name: 'Codex',
          api: 'openai-responses',
          baseUrl: 'http://10.0.0.5:8080',
          apiKey: KEYS.codex,
          models: [{ id: 'gpt-6-astra', name: 'gpt-6-astra' }],
          isCurrent: true,
        },
      ],
      warnings: [],
    });
  });

  it('多个服务：选中的排最前并带 model；其它的不带模型、不算当前；env_key 优先于 auth.json', () => {
    const config = `model_provider = "relay"
model = "gpt-6-sol"

[model_providers.local]
name = "Local LM"
base_url = "http://127.0.0.1:1234/v1"
wire_api = "chat"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example.com/v1"
env_key = "RELAY_API_KEY"
`;
    const result = readCodex({
      config,
      auth: codexAuthJson,
      env: { RELAY_API_KEY: 'sk-relay-from-env-7777' },
    });
    expect(result.warnings).toEqual([]);
    expect(result.providers).toEqual([
      expect.objectContaining({
        name: 'Codex',
        sourceLabel: 'Codex',
        // 没写 wire_api：按 Codex 的默认 chat
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay-from-env-7777',
        models: [
          expect.objectContaining({ id: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 272_000 }),
        ],
        isCurrent: true,
      }),
      expect.objectContaining({
        name: 'Codex · Local LM',
        sourceLabel: 'Codex · Local LM',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: [],
        isCurrent: false,
      }),
    ]);
    // 没有 requires_openai_auth 也没有 env_key 的服务不带 key：不把 OpenAI 的 key 发给别的端点
    expect(result.providers[1]).not.toHaveProperty('apiKey');
  });

  it('缺 key：env_key 指向的环境变量没设置时没有 apiKey，并提示变量名', () => {
    const config = `model_provider = "relay"
[model_providers.relay]
name = "Relay"
base_url = "https://relay.example.com/v1"
wire_api = "responses"
env_key = "RELAY_API_KEY"
`;
    const result = readCodex({ config, auth: null, env: {} });
    expect(result.providers).toEqual([expect.objectContaining({ name: 'Codex', models: [] })]);
    expect(result.providers[0]).not.toHaveProperty('apiKey');
    expect(result.warnings).toEqual([
      'Codex：环境变量 RELAY_API_KEY 没有设置，导入后需要在编辑里填写 API Key',
    ]);
  });

  it('没有自定义服务时是内置 OpenAI：auth.json 有 OPENAI_API_KEY 才算；ChatGPT 登录没有 key 不算', () => {
    expect(readCodex({ config: 'model = "gpt-6-sol"\n', auth: codexAuthJson, env: {} })).toEqual({
      providers: [
        expect.objectContaining({
          name: 'OpenAI',
          sourceLabel: 'Codex',
          api: 'openai-responses',
          apiKey: KEYS.codex,
          models: [expect.objectContaining({ id: 'gpt-6-sol' })],
          isCurrent: true,
        }),
      ],
      warnings: [],
    });
    expect(readCodex({ config: null, auth: codexAuthJson, env: {} }).providers).toHaveLength(1);

    const chatgpt = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'x' } });
    expect(readCodex({ config: null, auth: chatgpt, env: {} })).toEqual({
      providers: [],
      warnings: [],
    });
  });

  it('坏 TOML：整个来源跳过，warning 只给行号不带原文', () => {
    const broken = codexConfigToml.replace('wire_api = "responses"', 'wire_api = responses"');
    const result = readCodex({ config: broken, auth: codexAuthJson, env: {} });
    expect(result.providers).toEqual([]);
    expect(result.warnings).toEqual([
      'Codex：~/.codex/config.toml 第 11 行不是有效的 TOML，已跳过',
    ]);
    expect(JSON.stringify(result)).not.toContain('responses');
  });

  it('坏 auth.json：忽略其中的 key 并提示，config 里其它来源的 key 照常', () => {
    const config = `model_provider = "relay"
[model_providers.relay]
base_url = "https://relay.example.com/v1"
env_key = "RELAY_API_KEY"
requires_openai_auth = true
`;
    const result = readCodex({
      config,
      auth: `{ "OPENAI_API_KEY": "${KEYS.codex}"`,
      env: { RELAY_API_KEY: 'sk-relay-from-env-7777' },
    });
    expect(result.providers).toEqual([
      expect.objectContaining({ name: 'Codex', apiKey: 'sk-relay-from-env-7777' }),
    ]);
    expect(result.warnings).toEqual([
      'Codex：~/.codex/auth.json 不是有效的 JSON，已忽略其中的 key',
    ]);
    expect(JSON.stringify(result)).not.toContain(KEYS.codex);
  });
});

describe('readCodexConfig', () => {
  it('没有 base_url 的自定义服务跳过；没写 wire_api 时用调用方给的协议', () => {
    const config = {
      model_provider: 'custom',
      model_providers: {
        broken: { name: 'Broken' },
        custom: { base_url: 'https://x.example.com/v1', requires_openai_auth: true },
      },
    };
    const auth = { OPENAI_API_KEY: KEYS.sub2api };
    expect(readCodexConfig(config, auth, {}, 'openai-responses')).toEqual([
      {
        key: 'custom',
        name: 'custom',
        api: 'openai-responses',
        baseUrl: 'https://x.example.com/v1',
        apiKey: KEYS.sub2api,
        models: [],
        active: true,
      },
    ]);
  });
});
