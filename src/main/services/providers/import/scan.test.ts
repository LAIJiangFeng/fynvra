import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderImportSource } from '@shared/types/llm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredProvider } from '../providerStore';
import {
  ccSwitchRows,
  claudeSettingsJson,
  codexAuthJson,
  codexConfigToml,
  KEYS,
  loadSqlite,
  writeFakeHome,
} from './fixtures';
import { scanProviderImports } from './scan';

let base: string;
let home: string;
let tempRoot: string;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-import-scan-'));
  home = join(base, 'home');
  tempRoot = join(base, 'tmp');
  mkdirSync(home);
  mkdirSync(tempRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const scan = (sources?: ProviderImportSource[], existing: StoredProvider[] = []) =>
  scanProviderImports(sources, { existing, home, env: {}, tempDir: tempRoot });

const writeAll = () =>
  writeFakeHome(home, {
    claudeSettings: claudeSettingsJson,
    codexConfig: codexConfigToml,
    codexAuth: codexAuthJson,
    ccSwitchRows,
  });

const summary = (candidates: Awaited<ReturnType<typeof scan>>['candidates']) =>
  candidates.map(({ view }) => [
    view.sourceLabel,
    view.duplicate ?? null,
    view.duplicateOf ?? null,
  ]);

describe('scanProviderImports', () => {
  it('三个来源都在：按 Claude Code、Codex、CC Switch 排列，地址和 key 相同的保留排前面的', async () => {
    await writeAll();
    const { candidates, warnings } = await scan();
    expect(warnings).toEqual([]);
    expect(summary(candidates)).toEqual([
      ['Claude Code', null, null],
      ['Codex', null, null],
      ['CC Switch · 公司中转claude', 'candidate', 'Claude Code'],
      ['CC Switch · cursor', null, null],
      ['CC Switch · 君', null, null],
      ['CC Switch · default', 'candidate', 'Codex'],
      ['CC Switch · sub2api', null, null],
      ['CC Switch · Gemini 中转', null, null],
    ]);
    expect(new Set(candidates.map(({ view }) => view.id)).size).toBe(candidates.length);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('视图逐字段构造：没有 key，只有 hasApiKey 与末 4 位；导入用的入参里才有 key', async () => {
    await writeAll();
    const { candidates } = await scan();
    const [claude] = candidates;
    expect(claude?.view).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      name: 'Claude Code',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example.com',
      models: [expect.objectContaining({ id: 'claude-fable-5-1', name: 'Fable 5.1' })],
      hasApiKey: true,
      apiKeyHint: '1111',
      isCurrent: true,
    });
    expect(claude?.input).toEqual({
      name: 'Claude Code',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example.com',
      enabled: true,
      models: claude?.view.models,
      apiKey: KEYS.claudeCode,
    });
    const views = JSON.stringify(candidates.map(({ view }) => view));
    for (const key of Object.values(KEYS)) expect(views).not.toContain(key);
  });

  it('与已有服务地址和 key 都相同的标 existing，并给出已有服务的名称', async () => {
    await writeAll();
    const existing: StoredProvider[] = [
      {
        id: 'relay',
        name: '公司中转',
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com/',
        enabled: true,
        models: [],
        apiKey: KEYS.claudeCode,
      },
    ];
    const { candidates } = await scan(undefined, existing);
    expect(summary(candidates).slice(0, 3)).toEqual([
      ['Claude Code', 'existing', '公司中转'],
      ['Codex', null, null],
      ['CC Switch · 公司中转claude', 'existing', '公司中转'],
    ]);
  });

  it('只扫 CC Switch：排在前面的来源不在了，它的当前服务不再算重复', async () => {
    await writeAll();
    const { candidates } = await scan(['cc-switch']);
    expect(candidates.every(({ view }) => view.source === 'cc-switch')).toBe(true);
    expect(candidates.some(({ view }) => view.duplicate)).toBe(false);
    expect(
      (await scan(['codex', 'claude-code'])).candidates.map(({ view }) => view.source)
    ).toEqual(['claude-code', 'codex']);
  });

  it('单个来源读失败只记一条 warning，不影响其它来源', async () => {
    await writeFakeHome(home, { codexConfig: codexConfigToml, codexAuth: codexAuthJson });
    mkdirSync(join(home, '.claude', 'settings.json'), { recursive: true });
    mkdirSync(join(home, '.cc-switch'));
    writeFileSync(join(home, '.cc-switch', 'cc-switch.db'), 'not a database\n'.repeat(300));

    const { candidates, warnings } = await scan();
    expect(candidates.map(({ view }) => view.sourceLabel)).toEqual(['Codex']);
    expect(warnings).toEqual([
      expect.stringMatching(/^Claude Code：读取失败（.+）$/),
      expect.stringMatching(/^CC Switch：读取失败（.+）$/),
    ]);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('一个都没装：没有候选，也没有 warning', async () => {
    expect(await scan()).toEqual({ candidates: [], warnings: [] });
  });

  it('不能导入的候选（地址不是 http(s)）跳过并说明；过长的名称截断到 80 个字符', async () => {
    const longName = '很长的中转名称'.repeat(15);
    await writeFakeHome(home, {
      claudeSettings: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: KEYS.claudeCode,
          ANTHROPIC_BASE_URL: 'ftp://relay.example.com',
        },
      }),
      ccSwitchRows: ccSwitchRows
        .filter((row) => row.name === 'cursor')
        .map((row) => ({ ...row, name: longName })),
    });
    const { candidates, warnings } = await scan();
    expect(warnings).toEqual(['Claude Code：Base URL 必须是 http(s) 地址，已跳过']);
    expect(candidates.map(({ view }) => view.name)).toEqual([longName.slice(0, 80)]);
  });
});
