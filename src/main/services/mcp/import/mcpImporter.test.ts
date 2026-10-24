import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpImportSource } from '@shared/types/llm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpScanImportsResult } from '../../../../preload/domains/mcp';
import { createMcpRegistry, type McpRegistry, type StoredMcpServer } from '../mcpRegistry';
import {
  ALL_SOURCES,
  codexEnv,
  fakeAppData,
  loadSqlite,
  PENCIL_EXE,
  SECRETS,
  writeFakeHome,
} from './fixtures';
import { createMcpImporter, IMPORT_CACHE_TTL_MS } from './mcpImporter';
import { type McpImportScan, type ScannedMcpCandidate, scanMcpImports } from './scan';

let base: string;
let home: string;
let tempRoot: string;
let filePath: string;
let registry: McpRegistry;
let clock: number;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-mcp-importer-'));
  home = join(base, 'home');
  tempRoot = join(base, 'tmp');
  mkdirSync(tempRoot);
  filePath = join(base, 'userData', 'mcp.json');
  registry = createMcpRegistry({ filePath });
  clock = 1_760_000_000_000;
  await writeFakeHome(home, ALL_SOURCES);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Scan = (
  sources: readonly McpImportSource[],
  existing: readonly StoredMcpServer[]
) => Promise<McpImportScan>;

const realScan: Scan = (sources, existing) =>
  scanMcpImports(sources, {
    existing,
    home,
    env: { ...codexEnv, APPDATA: fakeAppData(home) },
    platform: 'win32',
    tempDir: tempRoot,
  });

const makeImporter = (scan: Scan = realScan) =>
  createMcpImporter({ registry, scan, now: () => clock });

function candidatesOf(result: McpScanImportsResult) {
  if (!result.ok) throw new Error(result.error);
  return result.candidates;
}

const idOf = (result: McpScanImportsResult, sourceLabel: string, name: string) => {
  const found = candidatesOf(result).find(
    (candidate) => candidate.sourceLabel === sourceLabel && candidate.name === name
  );
  if (!found) throw new Error(`没有候选 ${sourceLabel} · ${name}`);
  return found.id;
};

const disk = () => readFileSync(filePath, 'utf8');

describe('createMcpImporter', () => {
  it('扫描与导入的返回都不含 env / header 的值；值只写进 mcp.json；导入的都默认启用', async () => {
    const importer = makeImporter();
    const scanned = await importer.scan(undefined);
    expect(candidatesOf(scanned)).toHaveLength(32);
    const fresh = candidatesOf(scanned).filter((candidate) => !candidate.duplicate);

    const imported = await importer.import({ candidateIds: fresh.map((c) => c.id) });
    expect(imported).toMatchObject({ ok: true, skipped: [] });
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.imported).toHaveLength(fresh.length);
    expect(imported.imported.every((server) => server.enabled)).toBe(true);
    expect(imported.imported.find((server) => server.name === 'wechat-backup')).toMatchObject({
      transport: 'stdio',
      envKeys: ['WECHAT_BACKUP_DIR', 'TYPESAFE_API_KEY', 'SANITIZE'],
    });

    for (const secret of Object.values(SECRETS)) {
      expect(JSON.stringify(scanned)).not.toContain(secret);
      expect(JSON.stringify(imported)).not.toContain(secret);
      expect(disk()).toContain(secret);
    }
  });

  it('名称被占用时加后缀；在来源里没启用的导入后也是启用的；Windows 的 cmd /c 原样写进 mcp.json', async () => {
    await registry.upsert({
      name: 'context7',
      transport: 'http',
      url: 'https://other.example.com/mcp',
      enabled: true,
    });
    const importer = makeImporter();
    const scanned = await importer.scan({ sources: ['claude-code', 'opencode'] });
    const result = await importer.import({
      candidateIds: [
        idOf(scanned, 'Claude Code', 'context7'),
        idOf(scanned, 'OpenCode', 'context7'),
        idOf(scanned, 'Claude Code', 'pencil'),
      ],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.imported.map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual([
      { id: 'context7-2', name: 'context7 (2)', enabled: true },
      { id: 'context7-3', name: 'context7 (3)', enabled: true },
      { id: 'pencil', name: 'pencil', enabled: true },
    ]);
    const stored = await registry.get('context7-2');
    expect(stored).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
    });
    expect(await registry.get('pencil')).toMatchObject({ command: PENCIL_EXE });
  });

  it('导入时再查一次重复：与已有的或同批前面的相同就跳过并说明，重复点导入也不会建两份', async () => {
    const importer = makeImporter();
    const scanned = await importer.scan(undefined);
    const ids = [
      idOf(scanned, 'Claude Code', 'context7'),
      idOf(scanned, 'CC Switch · Claude', 'context7'),
    ];

    const first = await importer.import({ candidateIds: ids });
    expect(first).toMatchObject({
      ok: true,
      imported: [{ name: 'context7' }],
      skipped: [{ id: ids[1], name: 'context7', reason: '与「context7」的命令和参数相同' }],
    });
    const again = await importer.import({ candidateIds: ids });
    expect(again).toMatchObject({ ok: true, imported: [] });
    expect(again.ok && again.skipped).toHaveLength(2);
    expect((await registry.list()).map((server) => server.name)).toEqual(['context7']);
  });

  it('扫描结果 10 分钟后过期：import 返回错误；重新扫描后恢复', async () => {
    const importer = makeImporter();
    expect(await importer.import({ candidateIds: [crypto.randomUUID()] })).toEqual({
      ok: false,
      error: '扫描结果已过期，请重新扫描',
    });

    let scanned = await importer.scan(undefined);
    clock += IMPORT_CACHE_TTL_MS - 1;
    expect(
      await importer.import({ candidateIds: [idOf(scanned, 'Codex', 'stitch')] })
    ).toMatchObject({ ok: true });

    scanned = await importer.scan(undefined);
    clock += IMPORT_CACHE_TTL_MS;
    expect(await importer.import({ candidateIds: [idOf(scanned, 'Cursor', 'linear')] })).toEqual({
      ok: false,
      error: '扫描结果已过期，请重新扫描',
    });
    expect((await registry.list()).map((server) => server.name)).toEqual(['stitch']);
  });

  it('候选 id 不在最近一次扫描里（已被新的扫描替换）时返回错误，什么都不写', async () => {
    const importer = makeImporter();
    const stale = await importer.scan(undefined);
    await importer.scan({ sources: ['codex'] });
    expect(await importer.import({ candidateIds: [idOf(stale, 'Codex', 'stitch')] })).toEqual({
      ok: false,
      error: '候选不在最近一次扫描结果里，请重新扫描',
    });
    expect(await registry.list()).toEqual([]);
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
      { sources: ['windsurf'] },
      { sources: ['codex', 1] },
      { sources: ['codex'], extra: true },
      { extra: true },
      { sources: Array.from({ length: 17 }, () => 'codex') },
    ]) {
      expect(await importer.scan(raw)).toEqual({ ok: false, error: '无效的扫描参数' });
    }
    expect(scan).not.toHaveBeenCalled();

    await importer.scan({ sources: ['cc-switch', 'grok', 'grok'] });
    expect(scan).toHaveBeenLastCalledWith(['cc-switch', 'grok'], []);
    await importer.scan({});
    expect(scan).toHaveBeenLastCalledWith(
      ['claude-code', 'codex', 'grok', 'gemini', 'cursor', 'vscode', 'opencode', 'cc-switch'],
      []
    );

    const valid = crypto.randomUUID();
    for (const raw of [
      undefined,
      null,
      {},
      { candidateIds: [] },
      { candidateIds: valid },
      { candidateIds: [1] },
      { candidateIds: ['../mcp.json'] },
      { candidateIds: [valid.toUpperCase()] },
      { candidateIds: [valid], extra: true },
      { candidateIds: Array.from({ length: 501 }, () => crypto.randomUUID()) },
    ]) {
      expect(await importer.import(raw)).toEqual({ ok: false, error: '无效的导入参数' });
    }
    expect(await registry.list()).toEqual([]);
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

    expect(await importer.import({ candidateIds: [idOf(a, 'Cursor', 'first')] })).toMatchObject({
      ok: false,
    });
    expect(await importer.import({ candidateIds: [idOf(b, 'Cursor', 'second')] })).toMatchObject({
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
    const importer = createMcpImporter({
      registry: broken,
      scan: async () => ({ candidates: [fakeCandidate('x')], warnings: [] }),
      now: () => clock,
    });
    expect(await importer.scan(undefined)).toEqual({
      ok: false,
      error: '扫描本机配置失败：disk on fire',
    });

    const working = createMcpImporter({
      registry: { list: async () => [], addMany: broken.addMany },
      scan: async () => ({ candidates: [fakeCandidate('x')], warnings: [] }),
      now: () => clock,
    });
    const scanned = await working.scan(undefined);
    expect(await working.import({ candidateIds: [idOf(scanned, 'Cursor', 'x')] })).toEqual({
      ok: false,
      error: '导入失败：disk full',
    });
  });
});

function fakeCandidate(name: string): ScannedMcpCandidate {
  return {
    view: {
      id: crypto.randomUUID(),
      source: 'cursor',
      sourceLabel: 'Cursor',
      name,
      transport: 'stdio',
      command: name,
      envKeys: ['TOKEN'],
      headerKeys: [],
      enabledInSource: true,
    },
    server: { name, transport: 'stdio', command: name, env: { TOKEN: `${name}-secret` } },
  };
}
