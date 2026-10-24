import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorMessage, joinPath, parentDir, writeFileAtomic } from './files';

describe('joinPath', () => {
  it.each([
    [['C:\\Users\\a\\roles', 'x.json'], 'C:\\Users\\a\\roles\\x.json'],
    [['C:\\Users\\a\\roles\\', 'x.json'], 'C:\\Users\\a\\roles\\x.json'],
    [['C:/Users/a', 'ws', 'slug'], 'C:/Users/a/ws/slug'],
    [['/home/a/roles/', 'x.json'], '/home/a/roles/x.json'],
    [['relative', 'x'], 'relative/x'],
    [['/', 'x'], '/x'],
    [['C:\\', 'x'], 'C:\\x'],
  ])('%j → %s', (parts, expected) => {
    const [base = '', ...segments] = parts;
    expect(joinPath(base, ...segments)).toBe(expected);
  });
});

describe('parentDir', () => {
  it.each([
    ['C:\\a\\b.json', 'C:\\a'],
    ['/a/b.json', '/a'],
    ['/a/b/', '/a'],
    ['/b.json', '/'],
    ['C:\\b.json', 'C:\\'],
    ['b.json', '.'],
  ])('%s → %s', (path, expected) => {
    expect(parentDir(path)).toBe(expected);
  });
});

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fynvra-atomic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('写入目标文件，不留临时文件', async () => {
    const target = join(dir, 'state.json');
    await writeFileAtomic(nodeFs, target, 'v1');
    await writeFileAtomic(nodeFs, target, 'v2');
    expect(await readFile(target, 'utf8')).toBe('v2');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('rename 失败时抛出原错误、删除临时文件、保留旧内容', async () => {
    const target = join(dir, 'state.json');
    await writeFileAtomic(nodeFs, target, 'old');
    const failure = new Error('EBUSY');
    const fs = {
      ...nodeFs,
      rename: async () => {
        throw failure;
      },
    };
    await expect(writeFileAtomic(fs, target, 'new')).rejects.toBe(failure);
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(await readFile(target, 'utf8')).toBe('old');
  });
});

describe('errorMessage', () => {
  it('Error 取 message，其它值转字符串', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});
