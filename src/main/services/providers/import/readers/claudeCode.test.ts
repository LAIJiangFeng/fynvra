import { describe, expect, it } from 'vitest';
import { claudeSettingsJson, KEYS } from '../fixtures';
import { readAnthropicSettings, readClaudeCode } from './claudeCode';

describe('readClaudeCode', () => {
  it('本机格式：env 里的中转地址与 token，模型取 ANTHROPIC_DEFAULT_*_MODEL，别名 model 忽略', () => {
    expect(readClaudeCode(claudeSettingsJson)).toEqual({
      providers: [
        {
          source: 'claude-code',
          sourceLabel: 'Claude Code',
          name: 'Claude Code',
          api: 'anthropic-messages',
          baseUrl: 'https://relay.example.com',
          apiKey: KEYS.claudeCode,
          // 内置目录里有这个模型：带上上下文窗口等元数据，显示名用 env 里的 _NAME
          models: [
            {
              id: 'claude-fable-5-1',
              name: 'Fable 5.1',
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              reasoning: true,
            },
          ],
          isCurrent: true,
        },
      ],
      warnings: [],
    });
  });

  it('没有 AUTH_TOKEN 时取 ANTHROPIC_API_KEY；具体的 model id 排在最前，[1m] 后缀去掉，重复的合并', () => {
    const settings = {
      model: 'claude-opus-5-5[1m]',
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-api-key-9999',
        ANTHROPIC_MODEL: 'glm-5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
        ANTHROPIC_SMALL_FAST_MODEL: 'ignored-model',
      },
    };
    const [provider] = readClaudeCode(JSON.stringify(settings)).providers;
    expect(provider?.apiKey).toBe('sk-ant-api-key-9999');
    expect(provider?.baseUrl).toBeUndefined();
    expect(provider?.models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'glm-5']);
  });

  it('缺 key：只有地址时仍是候选，没有 apiKey', () => {
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' } };
    expect(readClaudeCode(JSON.stringify(settings)).providers).toEqual([
      expect.objectContaining({ baseUrl: 'https://relay.example.com', models: [] }),
    ]);
    expect(readClaudeCode(JSON.stringify(settings)).providers[0]).not.toHaveProperty('apiKey');
  });

  it('官方账号登录（没有 key 也没有地址）或没有 env：没有候选，也不算问题', () => {
    expect(readClaudeCode(JSON.stringify({ model: 'opus' }))).toEqual({
      providers: [],
      warnings: [],
    });
    expect(readClaudeCode(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '  ' } }))).toEqual({
      providers: [],
      warnings: [],
    });
  });

  it('坏 JSON 或不是对象：没有候选，记一条不带原文的 warning', () => {
    const broken = claudeSettingsJson.replace('"model"', 'model');
    for (const text of [broken, '[]', '']) {
      const result = readClaudeCode(text);
      expect(result.providers).toEqual([]);
      expect(result.warnings).toEqual([
        'Claude Code：~/.claude/settings.json 不是有效的 JSON，已跳过',
      ]);
      expect(JSON.stringify(result)).not.toContain(KEYS.claudeCode);
    }
  });
});

describe('readAnthropicSettings', () => {
  it('非字符串的值当作没填', () => {
    expect(
      readAnthropicSettings({
        env: { ANTHROPIC_AUTH_TOKEN: 42, ANTHROPIC_BASE_URL: ['https://x.example.com'] },
      })
    ).toBeNull();
    expect(readAnthropicSettings({ env: 'nope' })).toBeNull();
  });
});
