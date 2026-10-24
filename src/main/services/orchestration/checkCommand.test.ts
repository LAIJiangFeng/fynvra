import { describe, expect, it } from 'vitest';
import {
  type CheckCommandPolicy,
  checkCommand,
  DEFAULT_CHECK_COMMAND_POLICY,
} from './checkCommand';

describe('checkCommand', () => {
  it.each([
    'pnpm typecheck && pnpm lint && pnpm test',
    'pnpm test',
    '  pnpm test  ',
    'pnpm -C packages/core test',
    'pnpm -F @fynvra/core test -- --reporter=dot',
    'npm run build; npm test',
    'npm test | node scripts/summarize.js',
    'yarn lint',
    'bun test',
    'npx vitest run src/foo.test.ts',
    'node scripts\\check.js',
    'git status --porcelain',
    'git diff --check',
    'git log --oneline -5',
    'cargo test --workspace',
    'go test ./...',
    'python -m pytest tests',
    'pytest -k "not slow"',
    "pytest -k 'not slow'",
    'make check',
    'pnpm test 测试',
  ])('允许 %j', (command) => {
    expect(checkCommand(command)).toEqual({ ok: true, command: command.trim() });
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['rm -rf /', /"rm" is not an allowed program/],
    ['pnpm test; rm -rf /', /"rm" is not an allowed program/],
    ['pnpm test && curl http://example.invalid/x', /"curl"/],
    ['pnpm test | sh', /"sh"/],
    ['cd packages/core && pnpm test', /"cd".*-C/],
    ['./node_modules/.bin/vitest', /not an allowed program/],
    ['FOO=1 pnpm test', /not an allowed program/],
    ['PNPM test', /not an allowed program/],
    ['pnpm test $(whoami)', /"\$"/],
    ['pnpm test `whoami`', /"`"/],
    ['pnpm test > out.txt', /">"/],
    ['pnpm test < in.txt', /"<"/],
    ['pnpm test 2>&1', /">"/],
    ['(pnpm test)', /"\("/],
    ['pnpm test {a,b}', /"\{"/],
    ['pnpm test src/*.ts', /"\*"/],
    ['pnpm test %PATH%', /"%"/],
    ['pnpm test ^& calc', /"\^"/],
    ['pnpm test !1', /"!"/],
    ['pnpm test # comment', /"#"/],
    ['pnpm test &', /single "&"/],
    ['pnpm test & calc', /single "&"/],
    ['pnpm test || pnpm lint', /empty command/],
    ['pnpm test && ', /empty command/],
    ['&& pnpm test', /empty command/],
    ['pnpm test;; pnpm lint', /empty command/],
    ['pnpm test\nrm -rf /', /control character/],
    ['pnpm test\r\n', /control character/],
    ['git push origin main', /git push.*not allowed/],
    ['git commit -am wip', /git commit.*not allowed/],
    ['git -C ../other status', /git -C.*not allowed/],
    ['git', /git needs a subcommand/],
    ['git diff --output=x.txt', /--output/],
    ['git diff --ext-diff', /--ext-diff/],
    ['npm publish', /npm publish.*not allowed/],
    ['pnpm -r publish', /pnpm publish.*not allowed/],
    ['cargo publish --dry-run', /cargo publish.*not allowed/],
  ])('拒绝 %j', (command, error) => {
    const verdict = checkCommand(command);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.error).toMatch(error);
  });

  it('超长命令被拒绝', () => {
    expect(checkCommand(`pnpm test ${'a'.repeat(5000)}`)).toMatchObject({ ok: false });
  });

  it('白名单可配置：只认 policy 里列出的程序与子命令规则', () => {
    const policy: CheckCommandPolicy = { programs: ['deno', 'git'] };
    expect(checkCommand('deno test', policy).ok).toBe(true);
    expect(checkCommand('pnpm test', policy).ok).toBe(false);
    // 没有 git 子命令规则时 git 不受只读限制
    expect(checkCommand('git commit -m x', policy).ok).toBe(true);
  });

  it('默认策略的程序列表与任务书一致', () => {
    expect(DEFAULT_CHECK_COMMAND_POLICY.programs).toEqual([
      'pnpm',
      'npm',
      'yarn',
      'bun',
      'node',
      'npx',
      'git',
      'cargo',
      'go',
      'python',
      'pytest',
      'make',
    ]);
  });
});
