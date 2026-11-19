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
    ['package.json::$DATA', null],
    ['package.json.', null],
    ['package.json ', null],
    ['src/*.json', null],
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
    'PACKAG~1.JSO',
    'GITHUB~1/workflows/x.yml',
    'node_modules/typescript/lib/tsc.js',
    'packages/x/node_modules/a.js',
    '.gitattributes',
    'src/.gitattributes',
    '.gitmodules',
    '.pnpmfile.mjs',
    '.eslintrc.cjs',
    '.prettierrc',
    '.yarnrc.yml',
    'AGENTS.md',
    'docs/CLAUDE.md',
  ])('命中 %s', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each([
    'src/renderer/scripts/x.ts',
    'src/configure.ts',
    'docs/ARCHITECTURE.md',
    'src/rc.ts',
    'src/src.ts',
  ])('不命中 %s', (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });
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
    'ENV~1',
    '.env ',
    '.env.',
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
    "git commit --no-verify -m '修复：中文提交'",
    'git diff main..HEAD',
    'git show HEAD:src/a.ts',
    'git log --oneline -n 5',
    'git commit --no-verify -a -m x',
    'git commit --no-verify --verbose -m x',
    'git commit --no-verify --amend --no-edit',
    "git add 'pages/[id].tsx'",
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
    // Unicode 引号 / 不可见字符
    "git commit --no-verify -m 'x’; curl e; ’'",
    'git commit --no-verify -m "x” ; curl e ; “"',
    "git commit --no-verify -m 'a\u2028b'",
    // 读取仓库外文件
    'git diff C:/x/a src/a.ts',
    "git diff '/etc/passwd' a.ts",
    'git diff --no-index a b',
    'git diff --no-i a b',
    'git commit --no-verify -F C:/x',
    'git commit --no-verify --file=x -m y',
    'git commit --no-verify -t x -m y',
    'git add --pathspec-from-file=x',
    'git diff -O/x',
    'git show :/fix',
    "git show ':/fix'",
    "git rm ':(top)package.json'",
    'git log -- ../x',
    // 绕过 --no-verify / 打开编辑器
    'git commit -am -n',
    'git commit --no-verify --verify -m x',
    'git commit --no-verify --veri -m x',
    'git commit --no-verify --no-no-verify -m x',
    'git commit --no-verify',
    'git commit --no-verify -e -m x',
    // PowerShell 停止解析符
    'git commit --no-verify -m x --%',
    // 通配符与敏感文件
    "git rm 'src/[ab].ts'",
    "git rm '*.json'",
    'git add -f .env',
    'git add config/.env.local',
  ])('worker 拒绝 %j', (command) => {
    const result = checkRestrictedCommand(command, { mode: 'worker' });
    expect(result.ok).toBe(false);
  });

  it('git commit 缺 --no-verify 时 reason 写明要加', () => {
    const result = checkRestrictedCommand("git commit -m 'x'", { mode: 'worker' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('--no-verify') });
  });

  it('换行时 reason 提示用多个 -m', () => {
    const result = checkRestrictedCommand("git commit --no-verify -m 'a\nb'", { mode: 'worker' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('several -m') });
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
