import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ExecFn, nodeExec } from '../exec';
import { runTool } from '../test-utils/pipeline';
import {
  checkGitArgs,
  createGitReadonlyTool,
  createReadonlyTools,
  GIT_OUTPUT_MAX_CHARS,
} from './readonlyTools';

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('checkGitArgs', () => {
  it.each([
    [['status']],
    [['status', '--porcelain', '-b']],
    [['log', '--oneline', '-n', '20']],
    [['log', '--graph', '--decorate', 'main..fynvra/x']],
    [['diff', 'HEAD~1', '--', 'src/a.ts']],
    [['diff', '--stat', '--output-indicator-new=>']],
    [['show', 'HEAD:package.json']],
    [['branch']],
    [['branch', '-a', '-vv']],
    [['branch', '-av']],
    [['branch', '--list', 'fynvra/*']],
    [['branch', '--contains', 'HEAD']],
    [['branch', '--sort=-committerdate', '--format=%(refname:short)']],
    [['branch', '--show-current']],
    [['worktree', 'list']],
    [['worktree', 'list', '--porcelain']],
  ])('allows %j', (args) => {
    expect(checkGitArgs(args)).toEqual({ ok: true });
  });

  it.each([
    [[], 'subcommand'],
    [['commit', '-m', 'x'], 'not allowed'],
    [['push', 'origin'], 'not allowed'],
    [['STATUS'], 'not allowed'],
    [['-C', '..', 'status'], 'not allowed'],
    [['--git-dir=/tmp/x', 'log'], 'not allowed'],
    [['branch', 'new-feature'], 'create'],
    [['branch', '-D', 'fynvra/x'], 'branch -D'],
    [['branch', '-dr', 'origin/x'], 'branch -dr'],
    [['branch', '--merged', '-D'], 'branch -D'],
    [['branch', '--set-upstream-to=origin/main'], 'branch --set-upstream-to'],
    [['branch', '-m', 'a', 'b'], 'branch -m'],
    [['branch', '--', 'x'], 'branch --'],
    [['worktree'], 'worktree list'],
    [['worktree', 'add', '../x'], 'worktree list'],
    [['worktree', 'remove', 'x'], 'worktree list'],
    [['worktree', 'list', '--expire', 'now'], 'worktree list'],
    [['diff', '--output=/tmp/patch'], '--output'],
    [['log', '-p', '--output', '/tmp/patch'], '--output'],
    [['diff', '--ext-diff'], '--ext-diff'],
    [['status', ''], 'empty'],
    [['log', 'a\u0000b'], 'control'],
  ])('rejects %j', (args, reason) => {
    const result = checkGitArgs(args);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(reason);
  });
});

describe('git_readonly', () => {
  function fakeExec(stdout = ' M src/a.ts\n', code = 0, stderr = '') {
    return vi.fn<ExecFn>(async () => ({ code, stdout, stderr }));
  }

  it('runs whitelisted commands with git in the session cwd, without pager or optional locks', async () => {
    const exec = fakeExec();
    const run = await runTool(createGitReadonlyTool('/repo', exec), {
      args: ['status', '--short'],
    });
    expect(run.isError).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-pager', '--no-optional-locks', 'status', '--short'],
      '/repo',
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(run.text).toContain('M src/a.ts');
  });

  it('accepts a command string and a leading "git"', async () => {
    const exec = fakeExec();
    const tool = createGitReadonlyTool('/repo', exec);
    await runTool(tool, { args: 'log --oneline -5' });
    await runTool(tool, { args: ['git', 'diff', '--stat'] });
    expect(exec.mock.calls.map((call) => call[1].slice(2))).toEqual([
      ['log', '--oneline', '-5'],
      ['diff', '--stat'],
    ]);
  });

  it('refuses non-whitelisted commands without running anything', async () => {
    const exec = fakeExec();
    const tool = createGitReadonlyTool('/repo', exec);
    for (const args of [
      ['commit', '-am', 'x'],
      ['branch', '-D', 'main'],
      ['reset', '--hard'],
    ]) {
      const run = await runTool(tool, { args });
      expect(run).toMatchObject({ isError: true, stage: 'execute' });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns git failures as error text', async () => {
    const exec = fakeExec('', 128, "fatal: bad revision 'nope'");
    const run = await runTool(createGitReadonlyTool('/repo', exec), { args: ['log', 'nope'] });
    expect(run.isError).toBe(true);
    expect(run.text).toContain("fatal: bad revision 'nope'");
  });

  it('truncates long output and suggests narrowing the command', async () => {
    const exec = fakeExec(`${'a'.repeat(GIT_OUTPUT_MAX_CHARS)}END_OF_LOG`);
    const run = await runTool(createGitReadonlyTool('/repo', exec), { args: ['log'] });
    expect(run.text).not.toContain('END_OF_LOG');
    expect(run.text).toContain('truncated');
  });

  it('never throws when exec breaks its contract', async () => {
    const exec: ExecFn = () => {
      throw new Error('spawn exploded');
    };
    const tool = createGitReadonlyTool('/repo', exec);
    const run = await runTool(tool, { args: ['status'] });
    expect(run.isError).toBe(true);
    expect(run.text).toContain('spawn exploded');
    for (const params of [null, 1, { args: [1, 2] }]) {
      const result = await tool.execute('call', params as never, undefined, undefined, {} as never);
      expect(result.isError).toBe(true);
    }
  });
});

describe('createReadonlyTools', () => {
  it('combines the pi read / grep / find / ls tools with git_readonly', () => {
    expect(createReadonlyTools('/repo').map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'git_readonly',
    ]);
  });
});

describe('nodeExec', () => {
  it('resolves a missing executable as a non-zero code instead of rejecting', async () => {
    const result = await nodeExec('fynvra-definitely-missing-binary', [], process.cwd());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
  });
});

describe.skipIf(!hasGit)('git_readonly against a real repository', () => {
  let repo = '';
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'fynvra-git-readonly-'));
    expect((await nodeExec('git', ['init', '-q'], repo)).code).toBe(0);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs status and branch, and reports git errors as error text', async () => {
    const tool = createGitReadonlyTool(repo, nodeExec);
    expect((await runTool(tool, { args: ['status', '--short'] })).isError).toBe(false);
    expect((await runTool(tool, { args: ['branch', '--list'] })).isError).toBe(false);
    // 空仓库没有提交，git log 失败
    const log = await runTool(tool, { args: ['log', '-1'] });
    expect(log.isError).toBe(true);
    expect(log.text).toContain('exited with code');
  });
});
