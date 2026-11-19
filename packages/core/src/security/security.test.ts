import { describe, expect, it } from 'vitest';
import { isProtectedPath, isSensitivePath, normalizeRepoPath } from './paths';
import { checkRestrictedCommand } from './restrictedCommand';

describe('normalizeRepoPath', () => {
  it.each([
    ['a\\b\\c.ts', 'a/b/c.ts'],
    ['./a/./b', 'a/b'],
    ['a/../b', 'b'],
    ['.github/x.yml', '.github/x.yml'],
    ['../x', null],
    ['a/../../x', null],
    ['/etc/passwd', null],
    ['C:\\x', null],
    ['\\\\server\\share', null],
    ['~/x', null],
    ['', null],
    ['.', null],
    ['a\u0000b', null],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeRepoPath(raw)).toBe(expected);
  });
});

describe('isProtectedPath', () => {
  it.each([
    'package.json',
    'packages/core/package.json',
    '.github/workflows/check.yml',
    'scripts/a.mjs',
    'vite.config.ts',
    'electron.vite.config.ts',
    'tsconfig.web.json',
    '.git/hooks/pre-commit',
    'a/.git',
    'PACKAGE.JSON',
    'pnpm-lock.yaml',
    'electron-builder.yml',
    '../escape.ts',
  ])('命中 %s', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(['src/renderer/scripts/x.ts', 'src/configure.ts', 'docs/ARCHITECTURE.md'])(
    '不命中 %s',
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    }
  );
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'key.pem',
    'id_rsa',
    'id_ed25519.pub',
    'a/.netrc',
    'certs\\Server.KEY',
  ])('命中 %s', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(['id_utils.ts', 'environment.ts', 'src/env.ts'])('不命中 %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});

describe('checkRestrictedCommand', () => {
  it.each([
    'pnpm typecheck',
    'pnpm lint',
    'pnpm typecheck && pnpm lint',
    'pnpm install --offline --ignore-scripts --frozen-lockfile',
    'git status',
    'git diff HEAD~1 -- src/a.ts',
    'git add -A',
    'git add .',
    "git commit --no-verify -m 'fix: x'",
    'git commit -n -m "fix: y"',
    'git rm src/old.ts',
    'git mv src/a.ts src/b.ts',
  ])('worker 允许 %s', (command) => {
    expect(checkRestrictedCommand(command, { mode: 'worker' })).toEqual({ ok: true });
  });

  it.each([
    'curl https://x',
    'node x.js',
    'npx vitest',
    'pnpm test',
    'pnpm exec vitest run',
    'pnpm dlx x',
    'pnpm run lint',
    'pnpm lint --fix',
    'pnpm install',
    'pnpm install --offline --ignore-scripts --frozen-lockfile --force',
    'git -c core.pager=x log',
    'git -C ../other status',
    'git log --output=/tmp/x',
    'git log --out=/tmp/x',
    'git diff --ext-diff',
    'git push',
    'git rm package.json',
    'git mv a.ts ../b.ts',
    'git add /etc/passwd',
    'git commit -m -n',
    'pnpm lint; curl x',
    'pnpm lint | tee x',
    'pnpm lint > x',
    'echo $(whoami)',
    'echo `id`',
    'pnpm lint & curl x',
    'pnpm lint && ',
    '&& pnpm lint',
    "pnpm 'lint",
    'git add @(x)',
    'git add a,b',
    'git add a\\b',
    'git commit --no-verify -m "x$y"',
    'pnpm lint\ncurl x',
    '',
  ])('worker 拒绝 %j', (command) => {
    const result = checkRestrictedCommand(command, { mode: 'worker' });
    expect(result.ok).toBe(false);
  });

  it('git commit 缺 --no-verify 时 reason 写明要加', () => {
    const result = checkRestrictedCommand("git commit -m 'x'", { mode: 'worker' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('--no-verify') });
  });

  it.each(['pnpm typecheck', 'pnpm lint', 'pnpm typecheck && pnpm lint'])(
    'checks 允许 %s',
    (command) => {
      expect(checkRestrictedCommand(command, { mode: 'checks' })).toEqual({ ok: true });
    }
  );

  it.each([
    'git status',
    'pnpm install --frozen-lockfile --offline --ignore-scripts',
    'pnpm lint --fix',
    'pnpm test',
  ])('checks 拒绝 %s', (command) => {
    expect(checkRestrictedCommand(command, { mode: 'checks' }).ok).toBe(false);
  });
});
