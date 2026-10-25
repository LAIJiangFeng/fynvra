import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepositoryInspection } from './gitRepository';
import { createSettingsFile, type SettingsFile } from './settingsFile';
import { createWorkspaceService, toDisplayPath } from './workspaces';

let dir: string;
let settings: SettingsFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-workspaces-'));
  settings = createSettingsFile({ filePath: join(dir, 'settings.json') });
});

afterEach(() => {
  settings.flush();
  rmSync(dir, { recursive: true, force: true });
});

const repo = (root: string, name = 'fynvra'): RepositoryInspection => ({
  ok: true,
  root,
  name,
  defaultBranch: 'main',
});

const service = (inspection: RepositoryInspection, platform: NodeJS.Platform = 'linux') => {
  let next = 0;
  return createWorkspaceService({
    settings,
    inspect: async () => inspection,
    newId: () => `ws-${++next}`,
    home: '/home/dev',
    platform,
  });
};

describe('createWorkspaceService', () => {
  it('挂入仓库后写入 settings，Renderer 视图只有 id 与展示路径', async () => {
    const workspaces = service(repo('/home/dev/code/fynvra'));
    const result = await workspaces.addDirectory('/home/dev/code/fynvra');
    expect(result).toEqual({
      ok: true,
      created: true,
      workspace: {
        id: 'ws-1',
        name: 'fynvra',
        displayPath: '~/code/fynvra',
        vcs: 'git',
        defaultBranch: 'main',
      },
    });
    expect(workspaces.list()).toEqual([result.ok && result.workspace]);
    expect(workspaces.list()[0]).not.toHaveProperty('repoPath');
    expect(settings.read().workspaces).toEqual([
      {
        id: 'ws-1',
        name: 'fynvra',
        repoPath: '/home/dev/code/fynvra',
        vcs: 'git',
        defaultBranch: 'main',
      },
    ]);
    expect(workspaces.get('ws-1')?.repoPath).toBe('/home/dev/code/fynvra');
  });

  it('同一仓库重复挂入时返回已有记录，不产生重复条目', async () => {
    const workspaces = service(repo('/repos/fynvra'));
    await workspaces.addDirectory('/repos/fynvra');
    const again = await workspaces.addDirectory('/repos/fynvra');
    expect(again).toMatchObject({ ok: true, created: false, workspace: { id: 'ws-1' } });
    expect(settings.read().workspaces).toHaveLength(1);
  });

  it('Windows 下按大小写不敏感判重', async () => {
    const first = service(repo('C:\\Repos\\Fynvra'), 'win32');
    await first.addDirectory('C:\\Repos\\Fynvra');
    const again = await service(repo('c:\\repos\\fynvra'), 'win32').addDirectory(
      'c:\\repos\\fynvra'
    );
    expect(again).toMatchObject({ ok: true, created: false });
    expect(settings.read().workspaces).toHaveLength(1);
  });

  it('校验失败原样返回错误，不改动 settings', async () => {
    const rejected: RepositoryInspection = {
      ok: false,
      code: 'not-git-repo',
      error: '所选目录不是 git 仓库：/tmp/plain',
    };
    const result = await service(rejected).addDirectory('/tmp/plain');
    expect(result).toEqual(rejected);
    expect(settings.read().workspaces).toEqual([]);
  });

  it('按 id 移除；未知 id 返回 false', async () => {
    const workspaces = service(repo('/repos/fynvra'));
    await workspaces.addDirectory('/repos/fynvra');
    expect(workspaces.remove('ws-404')).toBe(false);
    expect(workspaces.remove('ws-1')).toBe(true);
    expect(workspaces.list()).toEqual([]);
  });
});

describe('toDisplayPath', () => {
  it('非 Windows 下把 home 前缀缩写为 ~', () => {
    expect(toDisplayPath('/home/dev', '/home/dev', 'linux')).toBe('~');
    expect(toDisplayPath('/home/dev/a', '/home/dev', 'darwin')).toBe('~/a');
    expect(toDisplayPath('/home/developer/a', '/home/dev', 'linux')).toBe('/home/developer/a');
  });

  it('Windows 下保留原路径', () => {
    expect(toDisplayPath('C:\\Users\\dev\\a', 'C:\\Users\\dev', 'win32')).toBe('C:\\Users\\dev\\a');
  });
});
