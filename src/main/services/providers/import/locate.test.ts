import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ccSwitchRows, insertRows, loadSqlite, PROVIDERS_TABLE, writeCcSwitchDb } from './fixtures';
import { locateImportSources, readCcSwitchRows, readTextIfExists } from './locate';

let base: string;
/** 库副本放这里，便于断言读完后删干净 */
let tempRoot: string;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-import-locate-'));
  tempRoot = join(base, 'tmp');
  mkdirSync(tempRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('locateImportSources', () => {
  it('三个来源在 home 下的固定位置', () => {
    const home = join(base, 'home');
    expect(locateImportSources(home)).toEqual({
      claudeSettings: join(home, '.claude', 'settings.json'),
      codexConfig: join(home, '.codex', 'config.toml'),
      codexAuth: join(home, '.codex', 'auth.json'),
      ccSwitchDb: join(home, '.cc-switch', 'cc-switch.db'),
    });
  });
});

describe('readTextIfExists', () => {
  it('不存在返回 null；去掉 UTF-8 BOM；其它读错误照常抛出', async () => {
    expect(await readTextIfExists(join(base, 'missing.json'))).toBeNull();
    writeFileSync(join(base, 'bom.json'), `${String.fromCharCode(0xfeff)}{"a":1}`);
    expect(await readTextIfExists(join(base, 'bom.json'))).toBe('{"a":1}');
    await expect(readTextIfExists(tempRoot)).rejects.toThrow();
  });
});

describe('readCcSwitchRows', () => {
  it('读出 providers 表的全部行；读的是副本，读完删除，源库一个字节都不变', async () => {
    const path = await writeCcSwitchDb(join(base, 'cc', 'cc-switch.db'), ccSwitchRows);
    const before = readFileSync(path);

    const rows = await readCcSwitchRows(path, tempRoot);
    expect(rows).toHaveLength(ccSwitchRows.length);
    expect(rows?.[0]).toMatchObject({ id: 'default', app_type: 'codex', is_current: 1 });
    expect(rows?.map((row) => row.name)).toContain('公司中转claude');

    expect(readdirSync(tempRoot)).toEqual([]);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(base, 'cc'))).toEqual(['cc-switch.db']);
  });

  it('库不存在返回 null', async () => {
    expect(await readCcSwitchRows(join(base, 'missing.db'), tempRoot)).toBeNull();
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('CC Switch 正开着库、新写入还在 -wal 里：读得到最新的行，也不影响它继续写', async () => {
    const { DatabaseSync } = await loadSqlite();
    const path = join(base, 'cc', 'cc-switch.db');
    mkdirSync(join(base, 'cc'));
    const live = new DatabaseSync(path);
    try {
      live.exec('PRAGMA journal_mode = WAL');
      live.exec(PROVIDERS_TABLE);
      insertRows(live, ccSwitchRows.slice(0, 3));
      expect(readdirSync(join(base, 'cc'))).toContain('cc-switch.db-wal');

      const rows = await readCcSwitchRows(path, tempRoot);
      expect(rows?.map((row) => row.name)).toEqual(['default', 'default', 'cursor']);
      expect(readdirSync(tempRoot)).toEqual([]);

      insertRows(live, ccSwitchRows.slice(3, 4));
      expect(live.prepare('SELECT count(*) AS n FROM providers').get()).toEqual({ n: 4 });
    } finally {
      live.close();
    }
  });

  it('没有 providers 表、不是 SQLite 文件：抛错（scan 记成该来源的 warning），副本照样删除', async () => {
    const { DatabaseSync } = await loadSqlite();
    const other = join(base, 'other.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.close();
    await expect(readCcSwitchRows(other, tempRoot)).rejects.toThrow('数据库里没有 providers 表');

    const garbage = join(base, 'garbage.db');
    writeFileSync(garbage, 'not a database, just text\n'.repeat(200));
    await expect(readCcSwitchRows(garbage, tempRoot)).rejects.toThrow();
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
