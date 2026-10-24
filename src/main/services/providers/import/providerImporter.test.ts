import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_CATALOG } from '@shared/modelCatalog';
import type { ProviderImportSource } from '@shared/types/llm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderScanImportsResult } from '../../../../preload/domains/providers';
import { createProviderStore, type ProviderStore, type StoredProvider } from '../providerStore';
import {
  ccSwitchRows,
  claudeSettingsJson,
  codexAuthJson,
  codexConfigToml,
  KEYS,
  loadSqlite,
  writeFakeHome,
} from './fixtures';
import { createProviderImporter, IMPORT_CACHE_TTL_MS } from './providerImporter';
import { type ProviderImportScan, type ScannedCandidate, scanProviderImports } from './scan';

let base: string;
let home: string;
let tempRoot: string;
let filePath: string;
let store: ProviderStore;
let clock: number;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-import-importer-'));
  home = join(base, 'home');
  tempRoot = join(base, 'tmp');
  mkdirSync(tempRoot);
  filePath = join(base, 'userData', 'providers.json');
  store = createProviderStore({ filePath });
  clock = 1_760_000_000_000;
  await writeFakeHome(home, {
    claudeSettings: claudeSettingsJson,
    codexConfig: codexConfigToml,
    codexAuth: codexAuthJson,
    ccSwitchRows,
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Scan = (
  sources: readonly ProviderImportSource[],
  existing: readonly StoredProvider[]
) => Promise<ProviderImportScan>;

const realScan: Scan = (sources, existing) =>
  scanProviderImports(sources, { existing, home, env: {}, tempDir: tempRoot });

const makeImporter = (scan: Scan = realScan) =>
  createProviderImporter({ store, scan, now: () => clock });

function candidatesOf(result: ProviderScanImportsResult) {
  if (!result.ok) throw new Error(result.error);
  return result.candidates;
}

const idOf = (result: ProviderScanImportsResult, sourceLabel: string) => {
  const found = candidatesOf(result).find((candidate) => candidate.sourceLabel === sourceLabel);
  if (!found) throw new Error(`没有候选 ${sourceLabel}`);
  return found.id;
};

const disk = () => readFileSync(filePath, 'utf8');

describe('createProviderImporter', () => {
  it('扫描与导入的返回都不含明文 key；key 只写进 providers.json', async () => {
    const importer = makeImporter();
    const scanned = await importer.scan(undefined);
    expect(candidatesOf(scanned)).toHaveLength(8);
    const fresh = candidatesOf(scanned).filter((candidate) => !candidate.duplicate);

    const imported = await importer.import({ candidateIds: fresh.map((c) => c.id) });
    expect(imported).toMatchObject({ ok: true, skipped: [] });
    expect(imported.ok && imported.imported.map((provider) => provider.name)).toEqual([
      'Claude Code',
      'Codex',
      'cursor',
      '君',
      'sub2api',
      'Gemini 中转',
    ]);
    expect(imported.ok && imported.imported[0]).toMatchObject({
      hasApiKey: true,
      apiKeyHint: '1111',
    });

    for (const key of [KEYS.claudeCode, KEYS.codex, KEYS.cursor, KEYS.jun, KEYS.sub2api]) {
      expect(JSON.stringify(scanned)).not.toContain(key);
      expect(JSON.stringify(imported)).not.toContain(key);
      expect(disk()).toContain(key);
    }
  });

  it('候选没带模型时按协议补内置目录的预置模型；名称被占用时加后缀', async () => {
    await store.upsert({
      name: 'Claude Code',
      api: 'anthropic-messages',
      enabled: true,
      models: [],
      apiKey: 'sk-some-other-key-8888',
    });
    const importer = makeImporter();
    const scanned = await importer.scan({ sources: ['claude-code', 'cc-switch'] });
    const result = await importer.import({
      candidateIds: [idOf(scanned, 'Claude Code'), idOf(scanned, 'CC Switch · cursor')],
    });
    if (!result.ok) throw new Error(result.error);

    const [claude, cursor] = result.imported;
    expect(claude).toMatchObject({ id: 'claude-code-2', name: 'Claude Code (2)', enabled: true });
    expect(claude?.models.map((model) => model.id)).toEqual(['claude-fable-5-1']);
    const anthropic = MODEL_CATALOG.find((entry) => entry.id === 'anthropic');
    expect(cursor?.models).toEqual(anthropic?.models);
  });

  it('导入时再查一次重复：与已有的或同批前面的相同就跳过并说明，重复点导入也不会建两份', async () => {
    const importer = makeImporter();
    const scanned = await importer.scan(undefined);
    const ids = [idOf(scanned, 'Claude Code'), idOf(scanned, 'CC Switch · 公司中转claude')];

    const first = await importer.import({ candidateIds: ids });
    expect(first).toMatchObject({
      ok: true,
      imported: [{ name: 'Claude Code' }],
      skipped: [
        {
          id: ids[1],
          name: '公司中转claude',
          reason: '与「Claude Code」的地址和 API Key 都相同',
        },
      ],
    });
    const again = await importer.import({ candidateIds: ids });
    expect(again).toMatchObject({ ok: true, imported: [] });
    expect(again.ok && again.skipped).toHaveLength(2);
    expect((await store.list()).map((provider) => provider.name)).toEqual(['Claude Code']);
  });

  it('扫描结果 10 分钟后过期：import 返回错误；重新扫描后恢复', async () => {
    const importer = makeImporter();
    expect(await importer.import({ candidateIds: [crypto.randomUUID()] })).toEqual({
      ok: false,
      error: '扫描结果已过期，请重新扫描',
    });

    let scanned = await importer.scan(undefined);
    clock += IMPORT_CACHE_TTL_MS - 1;
    expect(await importer.import({ candidateIds: [idOf(scanned, 'Codex')] })).toMatchObject({
      ok: true,
    });

    scanned = await importer.scan(undefined);
    clock += IMPORT_CACHE_TTL_MS;
    expect(await importer.import({ candidateIds: [idOf(scanned, 'CC Switch · 君')] })).toEqual({
      ok: false,
      error: '扫描结果已过期，请重新扫描',
    });
    expect((await store.list()).map((provider) => provider.name)).toEqual(['Codex']);
  });

  it('候选 id 不在最近一次扫描里（已被新的扫描替换）时返回错误，什么都不写', async () => {
    const importer = makeImporter();
    const stale = await importer.scan(undefined);
    await importer.scan({ sources: ['codex'] });
    expect(await importer.import({ candidateIds: [idOf(stale, 'Codex')] })).toEqual({
      ok: false,
      error: '候选不在最近一次扫描结果里，请重新扫描',
    });
    expect(await store.list()).toEqual([]);
  });

  it('入参收窄：形状不对一律拒绝，不扫描也不写盘', async () => {
    const scan = vi.fn<Scan>(async () => ({ candidates: [], warnings: [] }));
    const importer = makeImporter(scan);

    for (const raw of [
      null,
      'codex',
      ['codex'],
      { sources: [] },
      { sources: 'codex' },
      { sources: ['cursor'] },
      { sources: ['codex'], extra: true },
      { extra: true },
    ]) {
      expect(await importer.scan(raw)).toEqual({ ok: false, error: '无效的扫描参数' });
    }
    expect(scan).not.toHaveBeenCalled();

    await importer.scan({ sources: ['cc-switch', 'codex', 'codex'] });
    expect(scan).toHaveBeenLastCalledWith(['cc-switch', 'codex'], []);
    await importer.scan({});
    expect(scan).toHaveBeenLastCalledWith(['claude-code', 'codex', 'cc-switch'], []);

    const valid = crypto.randomUUID();
    for (const raw of [
      undefined,
      null,
      {},
      { candidateIds: [] },
      { candidateIds: valid },
      { candidateIds: [1] },
      { candidateIds: ['../providers.json'] },
      { candidateIds: [valid], extra: true },
      { candidateIds: Array.from({ length: 501 }, () => crypto.randomUUID()) },
    ]) {
      expect(await importer.import(raw)).toEqual({ ok: false, error: '无效的导入参数' });
    }
  });

  it('扫描排队执行：并发的两次扫描，缓存是后发起那次的结果', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const scan = vi.fn<Scan>(async () => {
      calls += 1;
      const label = calls === 1 ? 'first' : 'second';
      if (calls === 1) await gate;
      return { candidates: [fakeCandidate(label)], warnings: [] };
    });
    const importer = makeImporter(scan);

    const first = importer.scan(undefined);
    const second = importer.scan(undefined);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scan).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(await importer.import({ candidateIds: [idOf(a, 'first')] })).toMatchObject({
      ok: false,
    });
    expect(await importer.import({ candidateIds: [idOf(b, 'second')] })).toMatchObject({
      ok: true,
      imported: [{ name: 'second' }],
    });
  });

  it('读写注册表出错时返回 { ok: false }，不抛异常', async () => {
    const broken = {
      list: async () => {
        throw new Error('disk on fire');
      },
      addMany: async () => {
        throw new Error('disk full');
      },
    };
    const importer = createProviderImporter({
      store: broken,
      scan: async () => ({ candidates: [fakeCandidate('x')], warnings: [] }),
      now: () => clock,
    });
    expect(await importer.scan(undefined)).toEqual({
      ok: false,
      error: '扫描本机配置失败：disk on fire',
    });

    const working = createProviderImporter({
      store: { list: async () => [], addMany: broken.addMany },
      scan: async () => ({ candidates: [fakeCandidate('x')], warnings: [] }),
      now: () => clock,
    });
    const scanned = await working.scan(undefined);
    expect(await working.import({ candidateIds: [idOf(scanned, 'x')] })).toEqual({
      ok: false,
      error: '导入失败：disk full',
    });
  });
});

function fakeCandidate(label: string): ScannedCandidate {
  return {
    view: {
      id: crypto.randomUUID(),
      source: 'claude-code',
      sourceLabel: label,
      name: label,
      api: 'anthropic-messages',
      models: [],
      hasApiKey: true,
      apiKeyHint: '0000',
      isCurrent: true,
    },
    input: {
      name: label,
      api: 'anthropic-messages',
      baseUrl: `https://${label}.example.com`,
      enabled: true,
      models: [],
      apiKey: `sk-${label}-key-0000`,
    },
  };
}
