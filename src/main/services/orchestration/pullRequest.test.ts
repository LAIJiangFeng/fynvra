import { describe, expect, it } from 'vitest';
import { linkOrSubmodulePaths, pushGateError } from './pullRequest';

describe('linkOrSubmodulePaths', () => {
  it('取出新 mode 为符号链接或子模块的路径，删除的条目不算', () => {
    const raw = [
      ':000000 100644 0000000 1111111 A',
      'src/a.ts',
      ':000000 160000 0000000 2222222 A',
      'vendor/lib',
      ':120000 000000 3333333 0000000 D',
      'old-link',
      ':100644 120000 4444444 5555555 T',
      'src/now-link',
      '',
    ].join('\0');
    expect(linkOrSubmodulePaths(raw)).toEqual(['vendor/lib', 'src/now-link']);
  });
});

describe('pushGateError', () => {
  const base = { files: [], links: [], known: [], local: { paths: [], userName: 'admin' } };

  it('只查主机名与路径，不查单独的用户名单词', () => {
    expect(pushGateError({ ...base, restricted: false, text: 'role = admin' })).toBeNull();
    expect(
      pushGateError({
        ...base,
        restricted: false,
        text: 'built on build-host-1',
        local: { paths: [], hostName: 'build-host-1' },
      })
    ).toContain('host-name');
  });

  it('保护路径只对受限任务生效', () => {
    const input = { ...base, files: ['package.json'], text: '' };
    expect(pushGateError({ ...input, restricted: false })).toBeNull();
    expect(pushGateError({ ...input, restricted: true })).toContain('package.json');
  });
});
