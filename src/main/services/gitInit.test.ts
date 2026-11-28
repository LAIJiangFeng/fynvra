import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initGitRepository } from './gitInit';
import type { GitRunOptions, GitRunResult } from './gitRepository';

let dir: string;

beforeEach(() => {
  dir = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-git-init-'))), 'notes');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(dirname(dir), { recursive: true, force: true });
});

/** 假 GitRunner：按「命令前缀 → 结果」应答，记录调用顺序；没配置的命令成功且输出为空 */
function fakeGit(answers: Record<string, GitRunResult> = {}) {
  const calls: string[] = [];
  const options = new Map<string, GitRunOptions | undefined>();
  const run = async (
    args: string[],
    cwd: string,
    runOptions?: GitRunOptions
  ): Promise<GitRunResult> => {
    expect(cwd).toBe(dir);
    const command = args.join(' ');
    calls.push(command);
    options.set(args[0] ?? '', runOptions);
    const key = Object.keys(answers).find((prefix) => command.startsWith(prefix));
    return key ? (answers[key] as GitRunResult) : { ok: true, stdout: '' };
  };
  return { calls, options, run };
}

const notRepo: GitRunResult = { ok: false, error: 'fatal: not a git repository' };
const unset: GitRunResult = { ok: false, error: '' };

describe('initGitRepository', () => {
  it('成功路径：init → 补身份 → add → commit，按顺序执行', async () => {
    // 没配置的命令返回空输出，等同于身份未设置
    const { calls, options, run } = fakeGit({ 'rev-parse': notRepo });
    const result = await initGitRepository(dir, { run, userName: () => 'alice' });
    // add / commit 放宽超时与输出上限，其余用默认
    for (const command of ['add', 'commit']) {
      expect(options.get(command)?.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
      expect(options.get(command)?.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }
    expect(options.get('init')).toBeUndefined();
    expect(result).toEqual({ ok: true, alreadyRepo: false });
    expect(calls).toEqual([
      '--version',
      'rev-parse --show-toplevel',
      'init',
      'config user.name',
      'config user.name alice',
      'config user.email',
      'config user.email fynvra@localhost',
      'add -A',
      'commit -q --no-verify --allow-empty -m 初始化（Fynvra）',
    ]);
  });

  it('身份只在缺失时设置：已有 user.name 只补 user.email', async () => {
    const calls: string[] = [];
    const run = async (args: string[]): Promise<GitRunResult> => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return notRepo;
      if (args.join(' ') === 'config user.name') return { ok: true, stdout: 'Bob\n' };
      if (args.join(' ') === 'config user.email') return unset;
      return { ok: true, stdout: '' };
    };
    expect(await initGitRepository(dir, { run, userName: () => 'alice' })).toMatchObject({
      ok: true,
    });
    expect(calls.filter((call) => call.startsWith('config'))).toEqual([
      'config user.name',
      'config user.email',
      'config user.email fynvra@localhost',
    ]);
  });

  it('身份都已设置时不写配置', async () => {
    const { calls, run } = fakeGit({
      'rev-parse': notRepo,
      config: { ok: true, stdout: 'set\n' },
    });
    await initGitRepository(dir, { run });
    expect(calls.filter((call) => call.startsWith('config'))).toEqual([
      'config user.name',
      'config user.email',
    ]);
  });

  it('已经是仓库根目录：什么都不做', async () => {
    const { calls, run } = fakeGit({ 'rev-parse': { ok: true, stdout: `${dir}\n` } });
    expect(await initGitRepository(dir, { run })).toEqual({ ok: true, alreadyRepo: true });
    expect(calls).toEqual(['--version', 'rev-parse --show-toplevel']);
  });

  it('在外层仓库里：报错并给出外层路径，不 init', async () => {
    const outer = dirname(dir);
    const { calls, run } = fakeGit({ 'rev-parse': { ok: true, stdout: `${outer}\n` } });
    const result = await initGitRepository(dir, { run });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(outer);
    expect(calls).not.toContain('init');
  });

  it('git 不可用：返回 git-missing', async () => {
    const { calls, run } = fakeGit({
      '--version': { ok: false, error: 'ENOENT', missingGit: true },
    });
    expect(await initGitRepository(dir, { run })).toMatchObject({ ok: false, code: 'git-missing' });
    expect(calls).toEqual(['--version']);
  });

  it('commit 失败：附上 git 的报错，不再继续', async () => {
    const { run } = fakeGit({
      'rev-parse': notRepo,
      config: { ok: true, stdout: 'set' },
      commit: { ok: false, error: 'boom from git' },
    });
    const result = await initGitRepository(dir, { run });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('boom from git');
    expect(!result.ok && result.code).toBeUndefined();
  });
});
