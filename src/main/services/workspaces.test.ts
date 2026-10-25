import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryInspection } from './gitRepository';
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

const repo = (root: string, name = 'fynvra'): DirectoryInspection => ({
  ok: true,
  vcs: 'git',
  root,
  name,
  defaultBranch: 'main',
});

const plainDir = (root: string, name = 'notes'): DirectoryInspection => ({
  ok: true,
  vcs: 'none',
  root,
  name,
});

const service = (
  inspection:
    | DirectoryInspection
    | ((dir: string, options: { plain: boolean }) => DirectoryInspection),
  platform: NodeJS.Platform = 'linux'
) => {
  let next = 0;
  return createWorkspaceService({
    settings,
    inspect: async (dir, options) =>
      typeof inspection === 'function' ? inspection(dir, options) : inspection,
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

  it('普通目录按 vcs: none 挂入，没有默认分支', async () => {
    const result = await service(plainDir('/home/dev/notes')).addDirectory('/home/dev/notes');
    expect(result).toEqual({
      ok: true,
      created: true,
      workspace: { id: 'ws-1', name: 'notes', displayPath: '~/notes', vcs: 'none' },
    });
    expect(settings.read().workspaces).toEqual([
      { id: 'ws-1', name: 'notes', repoPath: '/home/dev/notes', vcs: 'none' },
    ]);
  });

  it('plain 原样交给 inspect（用户选了「仍然挂入该子目录」）', async () => {
    const inspect = vi.fn((dir: string, options: { plain: boolean }) =>
      options.plain ? plainDir(dir, 'src') : repo('/repos/fynvra')
    );
    const workspaces = service(inspect);
    const result = await workspaces.addDirectory('/repos/fynvra/src', { plain: true });
    expect(inspect).toHaveBeenCalledWith('/repos/fynvra/src', { plain: true });
    expect(result).toMatchObject({ ok: true, workspace: { vcs: 'none', name: 'src' } });
    await workspaces.addDirectory('/repos/fynvra');
    expect(inspect).toHaveBeenLastCalledWith('/repos/fynvra', { plain: false });
  });

  it.each<[string, DirectoryInspection]>([
    [
      '仓库子目录',
      {
        ok: false,
        code: 'not-repo-root',
        repoRoot: '/repos/fynvra',
        error: '所选目录位于 git 仓库 /repos/fynvra 内',
      },
    ],
    ['目录不存在', { ok: false, code: 'failed', error: '目录不存在或无法访问：/tmp/gone' }],
  ])('%s：原样返回，不改动 settings', async (_label, rejected) => {
    expect(await service(rejected).addDirectory('/tmp/x')).toEqual(rejected);
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
