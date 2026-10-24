import { describe, expect, it } from 'vitest';
import { type CcSwitchFixtureRow, ccSwitchRows, KEYS } from '../fixtures';
import { readCcSwitch } from './ccSwitch';

/** node:sqlite 读出的行：is_current 是数字，其余是字符串或 null。 */
const asDbRows = (rows: readonly CcSwitchFixtureRow[]) =>
  rows.map((row) => ({
    website_url: null,
    category: null,
    meta: '{}',
    ...row,
    is_current: row.is_current ?? 0,
  }));

describe('readCcSwitch', () => {
  it('本机格式：Claude / Codex / Gemini 三类，按类分组、当前的排前面；其它 app_type 与空占位跳过', () => {
    const result = readCcSwitch(asDbRows(ccSwitchRows), {});
    expect(result.warnings).toEqual([]);
    expect(
      result.providers.map(({ sourceLabel, name, api, baseUrl, isCurrent }) => ({
        sourceLabel,
        name,
        api,
        baseUrl,
        isCurrent,
      }))
    ).toEqual([
      {
        sourceLabel: 'CC Switch · 公司中转claude',
        name: '公司中转claude',
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com',
        isCurrent: true,
      },
      {
        sourceLabel: 'CC Switch · cursor',
        name: 'cursor',
        api: 'anthropic-messages',
        baseUrl: 'https://cursor-relay.example.com',
        isCurrent: false,
      },
      {
        sourceLabel: 'CC Switch · 君',
        name: '君',
        api: 'anthropic-messages',
        baseUrl: 'https://jun.example.com',
        isCurrent: false,
      },
      {
        sourceLabel: 'CC Switch · default',
        name: 'default',
        api: 'openai-responses',
        baseUrl: 'http://10.0.0.5:8080',
        isCurrent: true,
      },
      {
        sourceLabel: 'CC Switch · sub2api',
        name: 'sub2api',
        api: 'openai-responses',
        baseUrl: 'http://10.0.0.9:3000',
        isCurrent: false,
      },
      {
        sourceLabel: 'CC Switch · Gemini 中转',
        name: 'Gemini 中转',
        api: 'google-generative-ai',
        baseUrl: 'https://gemini-relay.example.com',
        isCurrent: true,
      },
    ]);
    expect(result.providers.every((provider) => provider.source === 'cc-switch')).toBe(true);
  });

  it('key 与模型：Claude 取 env（别名 model 忽略），Codex 取 auth 与 TOML 里的 model，Gemini 取 GEMINI_*', () => {
    const byName = new Map(
      readCcSwitch(asDbRows(ccSwitchRows), {}).providers.map((provider) => [
        provider.name,
        provider,
      ])
    );
    expect(byName.get('cursor')).toMatchObject({ apiKey: KEYS.cursor, models: [] });
    expect(byName.get('君')).toMatchObject({
      apiKey: KEYS.jun,
      models: [{ id: 'claude-opus-4-6', name: 'claude-opus-4-6' }],
    });
    expect(byName.get('default')).toMatchObject({
      apiKey: KEYS.codex,
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
    });
    expect(byName.get('Gemini 中转')).toMatchObject({
      apiKey: KEYS.gemini,
      models: [{ id: 'gemini-pro-latest', name: 'Gemini Pro Latest' }],
    });
  });

  it('meta.apiFormat：Codex 没写 wire_api 时决定协议；Claude 服务的 openai_chat 走 Chat Completions', () => {
    const rows = asDbRows([
      {
        id: 'chat-codex',
        app_type: 'codex',
        name: 'chat codex',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: KEYS.sub2api },
          config:
            'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://c.example.com/v1"\nrequires_openai_auth = true\n',
        }),
        meta: JSON.stringify({ apiFormat: 'openai_chat' }),
      },
      {
        id: 'chat-claude',
        app_type: 'claude',
        name: 'chat claude',
        settings_config: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: KEYS.jun, ANTHROPIC_BASE_URL: 'https://o.example.com/v1' },
        }),
        meta: JSON.stringify({ apiFormat: 'openai_chat' }),
      },
    ]);
    expect(readCcSwitch(rows, {}).providers.map((provider) => provider.api)).toEqual([
      'openai-completions',
      'openai-completions',
    ]);
  });

  it('Gemini 没有 GEMINI_API_KEY 时取 GOOGLE_API_KEY；地址可省略', () => {
    const rows = asDbRows([
      {
        id: 'g',
        app_type: 'gemini',
        name: 'Gemini',
        settings_config: JSON.stringify({ env: { GOOGLE_API_KEY: KEYS.gemini } }),
      },
    ]);
    expect(readCcSwitch(rows, {}).providers).toEqual([
      {
        source: 'cc-switch',
        sourceLabel: 'CC Switch · Gemini',
        name: 'Gemini',
        api: 'google-generative-ai',
        apiKey: KEYS.gemini,
        models: [],
        isCurrent: false,
      },
    ]);
  });

  it('坏 settings_config / 坏 TOML 只跳过那一行并记 warning（不带原文），其它行照常', () => {
    const rows = asDbRows([
      {
        id: 'bad-json',
        app_type: 'claude',
        name: '坏 JSON',
        settings_config: `{"env": {"ANTHROPIC_AUTH_TOKEN": "${KEYS.cursor}"`,
      },
      {
        id: 'bad-toml',
        app_type: 'codex',
        name: '坏 TOML',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: KEYS.sub2api },
          config: `model_provider = "custom"\n\n[model_providers.custom\nbase_url = "${KEYS.sub2api}"\n`,
        }),
      },
      ...ccSwitchRows.filter((row) => row.name === '君'),
    ]);
    const result = readCcSwitch(rows, {});
    expect(result.providers.map((provider) => provider.name)).toEqual(['君']);
    expect(result.warnings).toEqual([
      'CC Switch · 坏 JSON：settings_config 不是有效的 JSON，已跳过',
      'CC Switch · 坏 TOML：Codex 配置第 3 行不是有效的 TOML，已跳过',
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('sk-fake');
  });

  it('is_current 兼容 1 / true / "1"；缺 name 用 app_type', () => {
    const settings = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: KEYS.jun } });
    const rows = [
      { id: 'a', app_type: 'claude', name: '', settings_config: settings, is_current: true },
      { id: 'b', app_type: 'CLAUDE', name: 'b', settings_config: settings, is_current: '1' },
      { id: 'c', app_type: 'claude', name: 'c', settings_config: settings, is_current: 0n },
    ];
    expect(
      readCcSwitch(rows, {}).providers.map(({ name, isCurrent }) => ({ name, isCurrent }))
    ).toEqual([
      { name: 'claude', isCurrent: true },
      { name: 'b', isCurrent: true },
      { name: 'c', isCurrent: false },
    ]);
  });
});
