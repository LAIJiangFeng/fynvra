import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  GOOGLE_RELAY_MODELS,
  OPENAI_RELAY_MODELS,
} from './fixtures';
import { parseAnthropicModels, parseGoogleModels, parseOpenAiModels } from './parsers';

describe('parseAnthropicModels', () => {
  it('官方返回：data[].id 与 display_name，has_more 为 false', () => {
    expect(parseAnthropicModels(ANTHROPIC_MODELS)).toEqual({
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      ],
      invalid: 0,
      filtered: 0,
      more: false,
    });
  });

  it('has_more 为 true 时标出列表不完整', () => {
    expect(parseAnthropicModels({ ...ANTHROPIC_MODELS, has_more: true })?.more).toBe(true);
  });

  it('OpenAI 形态的列表也认得（没有显示名）', () => {
    expect(parseAnthropicModels(OPENAI_RELAY_MODELS)?.models[0]).toEqual({ id: 'gpt-6-sol' });
  });

  it('没有字符串 id 的条目计为无效；显示名为空白时不带', () => {
    const list = parseAnthropicModels({
      data: [{ id: 'claude-opus-5-5', display_name: '  ' }, { id: 42 }, null, 'claude', {}],
    });
    expect(list).toEqual({
      models: [{ id: 'claude-opus-5-5' }],
      invalid: 4,
      filtered: 0,
      more: false,
    });
  });

  it.each([
    ['不是 JSON', undefined],
    ['数组', [{ id: 'claude-opus-5-5' }]],
    ['没有 data', { object: 'list' }],
    ['data 不是数组', { data: { id: 'claude-opus-5-5' } }],
    ['错误信息', { type: 'error', error: { type: 'not_found_error', message: 'Not found' } }],
    ['条目都认不出', { data: [{ name: 'claude' }, { model: 'gpt' }] }],
  ])('非预期结构（%s）返回 null', (_label, body) => {
    expect(parseAnthropicModels(body)).toBeNull();
  });

  it('空列表是合法的结果', () => {
    expect(parseAnthropicModels({ data: [], has_more: false })).toEqual({
      models: [],
      invalid: 0,
      filtered: 0,
      more: false,
    });
  });
});

describe('parseOpenAiModels', () => {
  it('中转返回：只取 data[].id，owned_by / created 不进条目，重复留给调用方去重', () => {
    expect(parseOpenAiModels(OPENAI_RELAY_MODELS)).toEqual({
      models: [
        { id: 'gpt-6-sol' },
        { id: 'claude-opus-5-5' },
        { id: 'deepseek-chat' },
        { id: 'gpt-6-sol' },
      ],
      invalid: 0,
      filtered: 0,
      more: false,
    });
  });

  it('非预期结构返回 null', () => {
    expect(parseOpenAiModels(undefined)).toBeNull();
    expect(parseOpenAiModels({ models: [{ id: 'gpt-6-sol' }] })).toBeNull();
    expect(parseOpenAiModels({ data: [{ object: 'model' }] })).toBeNull();
  });
});

describe('parseGoogleModels', () => {
  it('去掉 models/ 前缀，带显示名与 token 上限；只留支持 generateContent 的', () => {
    expect(parseGoogleModels(GOOGLE_MODELS)).toEqual({
      models: [
        {
          id: 'gemini-4-argon',
          name: 'Gemini 4 Argon',
          contextWindow: 1_048_576,
          maxOutput: 32_768,
        },
        {
          id: 'gemini-flash-latest',
          name: 'Gemini Flash Latest',
          contextWindow: 1_048_576,
          maxOutput: 65_536,
        },
      ],
      invalid: 0,
      filtered: 2,
      more: false,
    });
  });

  it('没写 supportedGenerationMethods 的保留；nextPageToken 表示还有下一页', () => {
    expect(parseGoogleModels(GOOGLE_RELAY_MODELS)).toEqual({
      models: [{ id: 'gemini-pro-latest', name: 'Gemini Pro Latest' }],
      invalid: 0,
      filtered: 0,
      more: true,
    });
  });

  it('token 上限不是正整数时不带；name 不是字符串计为无效', () => {
    const list = parseGoogleModels({
      models: [
        { name: 'models/gemini-x', inputTokenLimit: 0, outputTokenLimit: '8192' },
        { name: 7, supportedGenerationMethods: ['generateContent'] },
      ],
    });
    expect(list).toEqual({ models: [{ id: 'gemini-x' }], invalid: 1, filtered: 0, more: false });
  });

  it('全部被过滤掉不算结构错误；认不出的列表返回 null', () => {
    expect(
      parseGoogleModels({
        models: [
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      })
    ).toEqual({ models: [], invalid: 0, filtered: 1, more: false });
    expect(parseGoogleModels({ data: [{ id: 'gemini-x' }] })).toBeNull();
    expect(parseGoogleModels({ models: [{ displayName: 'Gemini' }] })).toBeNull();
  });
});
