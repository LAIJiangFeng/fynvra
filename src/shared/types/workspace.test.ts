import { describe, expect, it } from 'vitest';
import { parseWorkspace, parseWorkspaceId } from './workspace';

describe('parseWorkspaceId（IPC 入参收窄）', () => {
  it('接受 Main 生成的不透明 id', () => {
    expect(parseWorkspaceId('3f2b9c1e-8d4a-4e6b-9f10-2a7c5d8e1b34')).toBe(
      '3f2b9c1e-8d4a-4e6b-9f10-2a7c5d8e1b34'
    );
  });

  it.each([
    ['非字符串', 42],
    ['空串', ''],
    ['超长', 'a'.repeat(65)],
    ['相对路径', '../settings.json'],
    ['Windows 路径', 'C:\\repos\\fynvra'],
    ['含空格', 'ws 1'],
    ['undefined', undefined],
  ])('拒绝 %s', (_label, raw) => {
    expect(parseWorkspaceId(raw)).toBeNull();
  });
});

describe('parseWorkspace', () => {
  const valid = {
    id: 'ws-1',
    name: 'fynvra',
    repoPath: '/repos/fynvra',
    vcs: 'git',
    defaultBranch: 'main',
  };

  it('只保留契约字段', () => {
    expect(parseWorkspace({ ...valid, extra: 'dropped' })).toEqual(valid);
  });

  it('没有 vcs 的旧记录是 git 仓库', () => {
    const { vcs: _vcs, ...legacy } = valid;
    expect(parseWorkspace(legacy)).toEqual(valid);
  });

  it('普通目录没有默认分支', () => {
    const plain = { id: 'ws-2', name: 'notes', repoPath: '/notes', vcs: 'none' };
    expect(parseWorkspace(plain)).toEqual(plain);
  });

  it.each([
    ['缺 repoPath', { ...valid, repoPath: undefined }],
    ['空名称', { ...valid, name: '' }],
    ['非法 id', { ...valid, id: 'a/b' }],
    ['未知 vcs', { ...valid, vcs: 'hg' }],
    ['vcs 大小写不同', { ...valid, vcs: 'Git' }],
    ['默认分支不是字符串', { ...valid, defaultBranch: 7 }],
    ['默认分支为空串', { ...valid, defaultBranch: '' }],
    ['非对象', 'ws-1'],
  ])('拒绝 %s', (_label, raw) => {
    expect(parseWorkspace(raw)).toBeNull();
  });
});
