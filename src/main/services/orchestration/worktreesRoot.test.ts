import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import type { Workspace } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectWorktreesRootInfo,
  configuredWorktreesRoot,
  createWorktreesRootResolver,
  defaultWorktreesRoot,
  fallbackWorktreesRoot,
  isInsideDirectory,
  measureDirectory,
  measureWorktrees,
  planWorktreesRoot,
  validateWorktreesRoot,
} from './worktreesRoot';

let base: string;
let userData: string;

function workspace(id: string, repoPath: string): Workspace {
  return { id, name: id, repoPath, vcs: 'git', defaultBranch: 'main' };
}

/** 父目录是个文件：在它下面建目录必然失败，跨平台模拟「仓库父目录不可写」。 */
function repoUnderAFile(): string {
  const blocker = join(base, 'blocker.txt');
  writeFileSync(blocker, '');
  return join(blocker, 'repo');
}

const denyWrites = {
  ...nodeFs,
  writeFile: async () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  },
};

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-worktrees-root-')));
  userData = join(base, 'userData');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('根目录推导（纯函数）', () => {
  it('默认：仓库同级的 <仓库目录名>-worktrees；仓库在根目录上时没有同级目录', () => {
    expect(defaultWorktreesRoot(join(base, 'project', 'fynvra'))).toBe(
      join(base, 'project', 'fynvra-worktrees')
    );
    expect(defaultWorktreesRoot(parse(base).root)).toBeUndefined();
  });

  it('配置了根目录：<根目录>/<仓库目录名>；退回目录是 userData/worktrees', () => {
    expect(configuredWorktreesRoot(join(base, 'wt'), join(base, 'project', 'fynvra'))).toBe(
      join(base, 'wt', 'fynvra')
    );
    expect(fallbackWorktreesRoot(userData)).toBe(join(userData, 'worktrees'));
  });

  it('isInsideDirectory：自身与子目录算在里面，前缀相同的兄弟目录、上级与别的盘不算', () => {
    expect(isInsideDirectory('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isInsideDirectory('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isInsideDirectory('/a/b/..c', '/a/b', 'linux')).toBe(true);
    expect(isInsideDirectory('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isInsideDirectory('/a', '/a/b', 'linux')).toBe(false);
    expect(isInsideDirectory('/A/B/c', '/a/b', 'linux')).toBe(false);
    expect(isInsideDirectory('D:\\Project\\Fynvra\\wt', 'd:\\project\\fynvra', 'win32')).toBe(true);
    expect(isInsideDirectory('E:\\project\\fynvra', 'D:\\project\\fynvra', 'win32')).toBe(false);
  });

  it('planWorktreesRoot：默认位置落在另一个已挂入的仓库里、或仓库在根目录上时退回 userData', () => {
    const fallbackRoot = fallbackWorktreesRoot(userData);
    const outer = join(base, 'outer');
    const nested = join(outer, 'vendor', 'lib');
    const repoPaths = [outer, nested];

    expect(planWorktreesRoot({ repoPath: outer, fallbackRoot, repoPaths })).toEqual({
      root: join(base, 'outer-worktrees'),
    });
    expect(planWorktreesRoot({ repoPath: nested, fallbackRoot, repoPaths })).toEqual({
      root: fallbackRoot,
      fallback: expect.stringContaining(outer),
    });
    expect(
      planWorktreesRoot({ repoPath: parse(base).root, fallbackRoot, repoPaths: [] })
    ).toMatchObject({ root: fallbackRoot, fallback: expect.any(String) });
    expect(
      planWorktreesRoot({ repoPath: nested, configured: join(base, 'wt'), fallbackRoot, repoPaths })
    ).toEqual({ root: join(base, 'wt', 'lib') });
  });
});

describe('createWorktreesRootResolver（每次建 worktree 时现算）', () => {
  function resolver(configured: () => string | undefined, fs?: typeof nodeFs) {
    const log = vi.fn();
    const resolve = createWorktreesRootResolver({
      fallbackRoot: fallbackWorktreesRoot(userData),
      configured,
      repoPaths: () => [],
      log,
      ...(fs ? { fs } : {}),
    });
    return { resolve, log };
  }

  it('默认建在仓库同级目录：先建出目录并确认可写，探测文件随即删掉', async () => {
    const repo = join(base, 'project', 'fynvra');
    const { resolve, log } = resolver(() => undefined);

    const root = await resolve(workspace('ws_1', repo));
    expect(root).toBe(join(base, 'project', 'fynvra-worktrees'));
    expect(readdirSync(root)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('仓库父目录不可写时退回 userData/worktrees 并记 warning', async () => {
    const { resolve, log } = resolver(() => undefined);
    expect(await resolve(workspace('ws_1', repoUnderAFile()))).toBe(join(userData, 'worktrees'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(join(userData, 'worktrees')));
  });

  it('目录建得出来但写不进文件时同样退回', async () => {
    const { resolve, log } = resolver(() => undefined, denyWrites);
    expect(await resolve(workspace('ws_1', join(base, 'repo')))).toBe(join(userData, 'worktrees'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('配置了根目录就用 <根目录>/<仓库目录名>，不探测也不退回（用不了时让 git 报错）', async () => {
    const configured = join(repoUnderAFile(), 'wt');
    const { resolve, log } = resolver(() => configured);
    expect(await resolve(workspace('ws_1', join(base, 'project', 'app')))).toBe(
      join(configured, 'app')
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('每次调用重读设置：改了之后下一次就用新位置', async () => {
    let configured: string | undefined;
    const { resolve } = resolver(() => configured);
    const ws = workspace('ws_1', join(base, 'project', 'app'));

    expect(await resolve(ws)).toBe(join(base, 'project', 'app-worktrees'));
    configured = join(base, 'wt');
    expect(await resolve(ws)).toBe(join(base, 'wt', 'app'));
    configured = undefined;
    expect(await resolve(ws)).toBe(join(base, 'project', 'app-worktrees'));
  });

  it('配置值不是绝对路径（手改 settings.json）时按默认处理并记 warning', async () => {
    const { resolve, log } = resolver(() => 'relative/wt');
    expect(await resolve(workspace('ws_1', join(base, 'project', 'app')))).toBe(
      join(base, 'project', 'app-worktrees')
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('relative/wt'));
  });
});

describe('validateWorktreesRoot（settings:pick-worktrees-root 的校验）', () => {
  const repo = () => join(base, 'project', 'fynvra');

  it('合法目录：规整成绝对路径并确认可创建、可写', async () => {
    const candidate = join(base, 'wt', '..', 'worktrees');
    const result = await validateWorktreesRoot(candidate, { repoPaths: [repo()] });
    expect(result).toEqual({ ok: true, path: join(base, 'worktrees') });
    expect(readdirSync(join(base, 'worktrees'))).toEqual([]);
  });

  it('拒绝相对路径', async () => {
    const result = await validateWorktreesRoot('worktrees', { repoPaths: [] });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('绝对路径') });
  });

  it('拒绝已挂入仓库本身及其内部目录，且不在仓库里建目录', async () => {
    for (const candidate of [repo(), join(repo(), '.worktrees')]) {
      const result = await validateWorktreesRoot(candidate, { repoPaths: [repo()] });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(repo()) });
    }
    expect(existsSync(join(repo(), '.worktrees'))).toBe(false);
  });

  it('拒绝仓库的父目录：<根目录>/<仓库目录名> 就是仓库本身', async () => {
    const result = await validateWorktreesRoot(dirname(repo()), { repoPaths: [repo()] });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(repo()) });
  });

  it('拒绝经 junction / 符号链接指进仓库的目录', async () => {
    mkdirSync(repo(), { recursive: true });
    const link = join(base, 'link-to-repo');
    symlinkSync(repo(), link, 'junction');
    const result = await validateWorktreesRoot(link, { repoPaths: [repo()] });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(repo()) });
  });

  it('拒绝建不出来或写不进去的目录', async () => {
    const blocked = await validateWorktreesRoot(join(repoUnderAFile(), 'wt'), { repoPaths: [] });
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining('无法') });

    const readOnly = await validateWorktreesRoot(join(base, 'wt'), {
      repoPaths: [],
      fs: denyWrites,
    });
    expect(readOnly).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
  });
});

describe('measureDirectory / measureWorktrees（占用统计）', () => {
  function tree(root: string, files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
  }

  it('递归累加文件大小；目录不存在时为 undefined', async () => {
    const root = join(base, 'wt');
    tree(root, { 'a.txt': '12345', 'src/b.ts': '123', 'src/deep/c.md': '1' });
    expect(await measureDirectory(root)).toEqual({ bytes: 9, files: 3 });
    expect(await measureDirectory(join(base, 'missing'))).toBeUndefined();
  });

  it('不跟随指向目录的 junction / 符号链接，硬链接只计一次', async () => {
    const outside = join(base, 'outside');
    tree(outside, { 'big.bin': 'x'.repeat(1000) });
    const root = join(base, 'wt');
    tree(root, { 'a.txt': '12345' });
    symlinkSync(outside, join(root, 'node_modules'), 'junction');
    linkSync(join(root, 'a.txt'), join(root, 'a-link.txt'));
    expect(await measureDirectory(root)).toEqual({ bytes: 5, files: 1 });
  });

  it('signal 中止时以 AbortError reject', async () => {
    const root = join(base, 'wt');
    tree(root, { 'a.txt': '1' });
    const controller = new AbortController();
    controller.abort();
    await expect(measureDirectory(root, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('measureWorktrees：合计各 worktree，不存在的计入 missing，彼此共享的硬链接只计一次', async () => {
    tree(join(base, 'one'), { 'a.txt': '1234' });
    tree(join(base, 'two'), { 'b.txt': '12' });
    linkSync(join(base, 'one', 'a.txt'), join(base, 'two', 'a.txt'));
    const usage = await measureWorktrees([
      { path: join(base, 'one') },
      { path: join(base, 'two') },
      { path: join(base, 'gone') },
    ]);
    expect(usage).toEqual({ bytes: 6, missing: 1 });
  });
});

describe('collectWorktreesRootInfo（settings:worktrees-root-info）', () => {
  const fallbackRoot = () => fallbackWorktreesRoot(userData);

  it('默认位置：各工作区的去向与登记的 worktree 数；不要求时不统计占用', async () => {
    const app = workspace('ws_1', join(base, 'project', 'app'));
    const worktreesOf = vi.fn(async (id: string) =>
      id === 'ws_1' ? [{ path: join(base, 'a') }, { path: join(base, 'b') }] : []
    );
    const info = await collectWorktreesRootInfo({
      configured: undefined,
      fallbackRoot: fallbackRoot(),
      workspaces: [app],
      worktreesOf,
      usage: false,
    });
    expect(info).toEqual({
      isDefault: true,
      fallbackRoot: fallbackRoot(),
      workspaces: [
        {
          workspaceId: 'ws_1',
          name: 'ws_1',
          root: join(base, 'project', 'app-worktrees'),
          count: 2,
        },
      ],
    });
    // 只读：设置页打开时不该在用户的项目目录里建出 -worktrees
    expect(existsSync(join(base, 'project', 'app-worktrees'))).toBe(false);
  });

  it('配置了根目录：标出路径，按要求统计占用', async () => {
    mkdirSync(join(base, 'a'));
    writeFileSync(join(base, 'a', 'x.txt'), 'abc');
    const info = await collectWorktreesRootInfo({
      configured: join(base, 'wt'),
      fallbackRoot: fallbackRoot(),
      workspaces: [workspace('ws_1', join(base, 'project', 'app'))],
      worktreesOf: async () => [{ path: join(base, 'a') }, { path: join(base, 'gone') }],
      usage: true,
    });
    expect(info).toEqual({
      isDefault: false,
      worktreesRoot: join(base, 'wt'),
      fallbackRoot: fallbackRoot(),
      workspaces: [
        {
          workspaceId: 'ws_1',
          name: 'ws_1',
          root: join(base, 'wt', 'app'),
          count: 2,
          usage: { bytes: 3, missing: 1 },
        },
      ],
    });
  });
});
