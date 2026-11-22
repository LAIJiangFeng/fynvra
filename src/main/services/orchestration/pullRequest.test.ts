import { describe, expect, it } from 'vitest';
import {
  buildPullRequestBody,
  linkOrSubmodulePaths,
  PR_BODY_CI_NOTE,
  pushGateError,
} from './pullRequest';

describe('buildPullRequestBody 的「验证」段', () => {
  const base = { taskId: 't1', summary: 'Fix.', files: ['src/a.ts'] };
  const verify = (body: string) => body.split('## 验证\n\n')[1];

  it('普通任务：列出通过的命令，没有时写「见 CI」', () => {
    expect(verify(buildPullRequestBody({ ...base, checks: ['pnpm lint'] }))).toBe(
      '- `pnpm lint`\n'
    );
    expect(verify(buildPullRequestBody({ ...base, checks: [], restricted: false }))).toBe(
      '见 CI\n'
    );
  });

  it('受限任务：命令后追加 Checks 说明；没有命令时替换「见 CI」', () => {
    expect(
      verify(buildPullRequestBody({ ...base, checks: ['pnpm typecheck'], restricted: true }))
    ).toBe(`- \`pnpm typecheck\`\n${PR_BODY_CI_NOTE}\n`);
    expect(verify(buildPullRequestBody({ ...base, checks: [], restricted: true }))).toBe(
      `${PR_BODY_CI_NOTE}\n`
    );
  });
});

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
