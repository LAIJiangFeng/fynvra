import { describe, expect, it } from 'vitest';
import { parseProviderUpsert } from './parseProviderInput';

const valid = {
  name: '  Anthropic  ',
  api: 'anthropic-messages',
  baseUrl: ' https://relay.example.com/ ',
  enabled: true,
  models: [{ id: ' claude-opus-5-5 ', name: '', contextWindow: 1_000_000, reasoning: true }],
  apiKey: '  sk-ant-secret  ',
};

describe('parseProviderUpsert', () => {
  it('规整合法入参：trim、模型名缺省用 id、末尾斜杠保留给 resolveBaseUrl 处理', () => {
    expect(parseProviderUpsert(valid)).toEqual({
      ok: true,
      input: {
        name: 'Anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com/',
        enabled: true,
        models: [
          {
            id: 'claude-opus-5-5',
            name: 'claude-opus-5-5',
            contextWindow: 1_000_000,
            reasoning: true,
          },
        ],
        apiKey: 'sk-ant-secret',
      },
    });
  });

  it('apiKey：缺省表示保留，null 表示清除；空 baseUrl 视为缺省', () => {
    const { apiKey: _omit, ...rest } = valid;
    const kept = parseProviderUpsert({ ...rest, id: 'anthropic', baseUrl: '  ' });
    expect(kept).toMatchObject({ ok: true, input: { id: 'anthropic' } });
    expect(kept.ok && 'apiKey' in kept.input).toBe(false);
    expect(kept.ok && 'baseUrl' in kept.input).toBe(false);
    expect(parseProviderUpsert({ ...valid, apiKey: null })).toMatchObject({
      ok: true,
      input: { apiKey: null },
    });
  });

  it.each([
    ['非对象', null],
    ['数组', [valid]],
    ['未知字段', { ...valid, apiKeyPlain: 'x' }],
    ['非法 id', { ...valid, id: '../etc' }],
    ['空名称', { ...valid, name: '   ' }],
    ['未知协议', { ...valid, api: 'ollama' }],
    ['非 http 地址', { ...valid, baseUrl: 'file:///etc/passwd' }],
    ['不是 URL', { ...valid, baseUrl: 'relay.example.com' }],
    ['enabled 缺失', { ...valid, enabled: undefined }],
    ['models 不是数组', { ...valid, models: {} }],
    ['模型缺 id', { ...valid, models: [{ name: 'x' }] }],
    ['模型 id 重复', { ...valid, models: [{ id: 'a' }, { id: 'a' }] }],
    ['模型字段非法', { ...valid, models: [{ id: 'a', contextWindow: -5 }] }],
    ['模型未知字段', { ...valid, models: [{ id: 'a', cost: 1 }] }],
    ['空 key', { ...valid, apiKey: '   ' }],
    ['key 含空白', { ...valid, apiKey: 'sk-ant one' }],
  ])('拒绝 %s', (_label, raw) => {
    const result = parseProviderUpsert(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
  });
});
