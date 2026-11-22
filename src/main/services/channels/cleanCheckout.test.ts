import { join } from 'node:path';
import type { Workspace } from '@shared/types/workspace';
import { describe, expect, it } from 'vitest';
import { cleanCheckoutDir, createCleanCheckout, type GitExec } from './cleanCheckout';

const TG = 'com.fynvra.telegram';

const SHA = 'a'.repeat(40);
const workspace: Workspace = {
  id: 'ws1',
  name: 'repo',
  repoPath: '/repo',
  vcs: 'git',
  defaultBranch: 'main',
};

function fakeGit(options: { origin?: boolean } = {}) {
  const calls: { args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const git: GitExec = async (args, { cwd, env }) => {
    calls.push({ args, cwd, env });
    if (args[0] === 'rev-parse') {
      return options.origin === false
        ? { ok: false, error: 'missing' }
        : { ok: true, stdout: `${SHA}\n` };
    }
    return { ok: true, stdout: '' };
  };
  return { git, calls };
}

describe('clean checkout', () => {
  it('路径在 <worktreesRoot>/<workspaceId>/telegram-clean，用 origin/<default> 建 detached worktree 并刷新', async () => {
    const { git, calls } = fakeGit();
    let exists = false;
    const checkout = createCleanCheckout({
      git,
      worktreesRoot: async () => '/wt',
      commandEnv: () => ({ HTTPS_PROXY: 'http://proxy:8080' }),
      exists: () => exists,
      now: () => 0,
    });
    const path = join('/wt', 'ws1', 'telegram-clean');
    expect(await checkout.ensure(workspace, TG)).toEqual({ ok: true, path });
    expect(calls[0]?.args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main^{commit}',
    ]);
    const add = calls.find((call) => call.args.includes('add'));
    expect(add?.cwd).toBe('/repo');
    expect(add?.args.slice(-4)).toEqual(['add', '--detach', path, SHA]);

    exists = true;
    calls.length = 0;
    expect(await checkout.refresh(workspace, TG)).toEqual({ ok: true });
    const fetch = calls.find((call) => call.args[0] === 'fetch');
    expect(fetch?.args).toEqual(['fetch', 'origin', 'main']);
    expect(fetch?.env).toMatchObject({
      HTTPS_PROXY: 'http://proxy:8080',
      GIT_TERMINAL_PROMPT: '0',
    });
    const co = calls.find((call) => call.args.includes('checkout'));
    expect(co?.cwd).toBe(path);
    expect(co?.args.slice(-4)).toEqual([
      'checkout',
      '--detach',
      '--force',
      'refs/remotes/origin/main',
    ]);
    expect(calls.at(-1)).toMatchObject({ args: ['clean', '-ffdx'], cwd: path });

    // 10 分钟内不再 fetch
    calls.length = 0;
    await checkout.refresh(workspace, TG);
    expect(calls.some((call) => call.args[0] === 'fetch')).toBe(false);
  });

  it('其他插件各用 clean-<pluginId>；非法 pluginId 报错且不碰 git', async () => {
    const { git, calls } = fakeGit();
    const checkout = createCleanCheckout({
      git,
      worktreesRoot: async () => '/wt',
      commandEnv: () => ({}),
      exists: () => true,
    });
    expect(await checkout.ensure(workspace, 'com.fynvra.feishu')).toEqual({
      ok: true,
      path: join('/wt', 'ws1', 'clean-com.fynvra.feishu'),
    });
    expect(cleanCheckoutDir('com.acme.chat')).toBe('clean-com.acme.chat');
    calls.length = 0;
    for (const bad of ['../x', 'com.fynvra/../a', 'com..x', '', 'COM.A']) {
      expect(() => cleanCheckoutDir(bad)).toThrow('invalid plugin id');
      expect(await checkout.ensure(workspace, bad)).toEqual({
        ok: false,
        error: 'invalid plugin id',
      });
      expect(await checkout.refresh(workspace, bad)).toEqual({
        ok: false,
        error: 'invalid plugin id',
      });
      await expect(checkout.pathOf(workspace, bad)).rejects.toThrow('invalid plugin id');
    }
    expect(calls).toEqual([]);
  });

  it('没有 origin/<default> 时拒绝', async () => {
    const { git, calls } = fakeGit({ origin: false });
    const checkout = createCleanCheckout({
      git,
      worktreesRoot: async () => '/wt',
      commandEnv: () => ({}),
      exists: () => false,
    });
    const result = await checkout.ensure(workspace, TG);
    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.args.includes('worktree'))).toBe(false);
  });
});
