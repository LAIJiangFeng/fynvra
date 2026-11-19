import { readFileSync } from 'node:fs';
import type { DispatchTaskOutput, OrchestrationHost } from '@fynvra/agent-runtime';
import { GitWorktreeManager, Inbox, InMemoryOrchestrationStore } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationHost, type OrchestrationHostDeps } from './host';
import { setPullRequestBodyExtension, setPushGateRestrictedLookup } from './pullRequest';
import { createFakeExec, createFakeLauncher, createFakeRoles, type FakeExec } from './testing';
import { createWorkerHost } from './workerHost';

vi.mock('./worktreeCleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktreeCleanup')>()),
  worktreeGone: async () => false,
}));

const WORKSPACE = {
  id: 'ws_1',
  name: 'demo',
  repoPath: '/repo',
  vcs: 'git' as const,
  defaultBranch: 'main',
};
const BRANCH = 'fynvra/add-toggle';
const HEAD = 'head1111111111111111111111111111111111111';
const MB = 'mb22222222222222222222222222222222222222222';
const KNOWN = 'super-secret-value-1';
const PR_URL = 'https://github.com/o/r/pull/7';

let store: InMemoryOrchestrationStore;
let inbox: Inbox;
let fake: FakeExec;
let host: OrchestrationHost;
let bodies: string[];

function makeHost(overrides: Partial<OrchestrationHostDeps> = {}): OrchestrationHost {
  return createOrchestrationHost({
    workspace: WORKSPACE,
    coordinatorSessionId: 'session_coord',
    coordinatorBranch: 'main',
    store,
    git: new GitWorktreeManager({ exec: fake.exec }),
    inbox,
    launcher: createFakeLauncher(),
    roles: createFakeRoles(),
    runChecks: async () => ({ exitCode: 0, output: 'ok', durationMs: 1 }),
    resolveWorktreesRoot: async () => '/data/worktrees',
    exec: fake.exec,
    now: () => 1000,
    pullRequestGate: {
      knownSecrets: async () => [KNOWN],
      localInfo: async () => ({ paths: ['/home/alice'], userName: 'alice', windows: false }),
    },
    ...overrides,
  });
}

/** 一个正常的仓库：worker 分支有 1 个新提交、改了 src/a.ts，gh 已装且已登录，还没有 PR。 */
function scriptRepo(
  diff = 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n',
  log = 'Add toggle\n'
) {
  fake.respond(({ cmd, args }) => {
    const line = args.join(' ');
    if (cmd === 'gh' && line.startsWith('pr list')) return { stdout: '[]\n' };
    if (cmd === 'gh' && line.startsWith('pr create')) {
      const file = args[args.indexOf('--body-file') + 1] ?? '';
      bodies.push(readFileSync(file, 'utf8'));
      return { stdout: `Creating pull request\n${PR_URL}\n` };
    }
    if (cmd !== 'git') return undefined;
    if (line === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`)
      return { stdout: `${HEAD}\n` };
    if (args[0] === 'merge-base') return { stdout: `${MB}\n` };
    if (line === `rev-list --count ${MB}..${HEAD}`) return { stdout: '1\n' };
    if (line.startsWith('diff --name-only')) return { stdout: 'src/a.ts\0' };
    if (line.startsWith('diff --no-color')) return { stdout: diff };
    if (args[0] === 'log') return { stdout: log };
    return undefined;
  });
}

beforeEach(() => {
  store = new InMemoryOrchestrationStore();
  inbox = new Inbox({ messages: store.messages });
  fake = createFakeExec();
  fake.respond(({ args }) => (args[0] === 'rev-list' ? { stdout: '0\t0\n' } : undefined));
  bodies = [];
  host = makeHost();
});
afterEach(() => {
  setPullRequestBodyExtension(undefined);
  setPushGateRestrictedLookup(undefined);
});

type Dispatched = DispatchTaskOutput & { dispatch: NonNullable<DispatchTaskOutput['dispatch']> };

async function reported(): Promise<Dispatched> {
  const result = await host.dispatchTask({
    title: 'Add toggle',
    spec: 'Do it.',
    roleId: 'worker',
    dependsOn: [],
  });
  if (!result.ok || result.dispatch === undefined) throw new Error(JSON.stringify(result));
  const runId = result.task.runId;
  const worker = createWorkerHost({ store, inbox, runId, dispatchId: result.dispatch.id });
  expect(await worker.reportDone('succeeded', 'Done.')).toEqual({ ok: true });
  return result as Dispatched;
}

const input = (dispatchId: string) => ({ dispatchId, title: 'Add toggle', summary: 'Adds it.' });
const pushedOrGh = (start: number) =>
  fake
    .commands()
    .slice(start)
    .filter((line) => line.startsWith('gh ') || line.startsWith('git push'));

describe('openPullRequest', () => {
  it('成功：push 与 gh 的 argv、正文文件、任务状态与 mergedDiff / pullRequest', async () => {
    const first = await reported();
    scriptRepo();
    setPullRequestBodyExtension((taskId) =>
      taskId === first.task.id ? '## 来源\n\n卡片 #1' : undefined
    );
    await host.runChecks({ dispatchId: first.dispatch.id, command: 'pnpm test' });
    const start = fake.calls.length;
    const result = await host.openPullRequest({ ...input(first.dispatch.id), draft: true });
    expect(result).toEqual({
      ok: true,
      url: PR_URL,
      branch: BRANCH,
      base: 'main',
      headCommit: HEAD,
    });

    const gh = pushedOrGh(start);
    expect(gh.slice(0, 5)).toEqual([
      'gh --version',
      'gh auth status',
      `git push -u origin ${BRANCH}`,
      `gh pr list --head ${BRANCH} --state open --json url`,
      expect.stringMatching(
        new RegExp(
          `^gh pr create --head ${BRANCH} --base main --title Add toggle --body-file .+ --draft$`
        )
      ),
    ]);
    const create = fake.calls.find((call) => call.cmd === 'gh' && call.args[1] === 'create');
    expect(create?.args).toContain('Add toggle');
    expect(
      fake.calls.filter((call) => call.cmd === 'gh').every((call) => call.cwd === '/repo')
    ).toBe(true);
    expect(bodies).toEqual([
      '## 改动\n\nAdds it.\n\n## 文件\n\n- `src/a.ts`\n\n## 验证\n\n- `pnpm test`\n\n## 来源\n\n卡片 #1\n',
    ]);
    expect(store.tasks.get(first.task.id)).toMatchObject({
      status: 'completed',
      mergedDiff: { headCommit: HEAD },
      pullRequest: { url: PR_URL, branch: BRANCH, base: 'main', headCommit: HEAD },
    });
  });

  it('没有通过的 run_checks 时写「见 CI」', async () => {
    const first = await reported();
    scriptRepo();
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({ ok: true });
    expect(bodies[0]).toContain('## 验证\n\n见 CI');
  });

  it('分支已有 PR：直接返回它的链接，不再创建', async () => {
    const first = await reported();
    scriptRepo();
    fake.respond(({ cmd, args }) =>
      cmd === 'gh' && args[1] === 'list' ? { stdout: `[{"url":"${PR_URL}"}]` } : undefined
    );
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({
      ok: true,
      url: PR_URL,
    });
    expect(fake.commands().some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(store.tasks.get(first.task.id)?.status).toBe('completed');
  });

  it('没装 gh：可读错误，不推送，状态不变', async () => {
    const first = await reported();
    scriptRepo();
    const exec = fake.exec;
    host = makeHost({
      exec: async (cmd, args, cwd) => {
        if (cmd === 'gh') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        return exec(cmd, args, cwd);
      },
    });
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
    expect(fake.commands().some((line) => line.startsWith('git push'))).toBe(false);
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });

  it('push 失败：任务状态不变，错误里的已知密钥被打码', async () => {
    const first = await reported();
    scriptRepo();
    fake.respond(({ args }) =>
      args[0] === 'push'
        ? { code: 1, stderr: `fatal: https://x:${KNOWN}@github.com denied` }
        : undefined
    );
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('git push failed') });
    expect(JSON.stringify(result)).not.toContain(KNOWN);
    expect(store.tasks.get(first.task.id)).toMatchObject({ status: 'in-review' });
    expect(store.tasks.get(first.task.id)?.pullRequest).toBeUndefined();
  });

  const changedFiles = (stdout: string) =>
    fake.respond(({ args }) =>
      args[0] === 'diff' && args[1] === '--name-only' ? { stdout } : undefined
    );

  it('受限任务改了 package.json：拒绝并列出文件，不推送', async () => {
    const first = await reported();
    setPushGateRestrictedLookup((taskId) => taskId === first.task.id);
    scriptRepo();
    changedFiles('src/a.ts\0package.json\0');
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('package.json') });
    expect(pushedOrGh(0)).toEqual([]);
  });

  it('普通任务改了 package.json 与 .github：放行，照常 push（保留用户 hooks）', async () => {
    const first = await reported();
    scriptRepo();
    changedFiles('package.json\0.github/workflows/ci.yml\0');
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({ ok: true });
    expect(fake.commands()).toContain(`git push -u origin ${BRANCH}`);
    expect(fake.commands().some((line) => line.startsWith('git diff --raw'))).toBe(false);
  });

  it('受限任务把保护文件改名移走：不认重命名，旧名字也在列表里，拒绝', async () => {
    const first = await reported();
    setPushGateRestrictedLookup(() => true);
    scriptRepo();
    changedFiles('AGENTS.md\0docs/agents.txt\0');
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('AGENTS.md') });
    expect(fake.commands()).toContain(`git diff --name-only --no-renames -z ${MB}..${HEAD}`);
    expect(pushedOrGh(0)).toEqual([]);
  });

  it('受限任务新增符号链接：拒绝', async () => {
    const first = await reported();
    setPushGateRestrictedLookup(() => true);
    scriptRepo();
    fake.respond(({ args }) =>
      args[0] === 'diff' && args[1] === '--raw'
        ? {
            stdout: `:000000 100644 ${'0'.repeat(7)} abc1234 A\0src/a.ts\0:000000 120000 ${'0'.repeat(7)} def5678 A\0src/link\0`,
          }
        : undefined
    );
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('symlinks or submodules (src/link)'),
    });
    expect(fake.commands()).toContain(`git diff --raw --no-renames -z ${MB}..${HEAD}`);
    expect(pushedOrGh(0)).toEqual([]);
  });

  it('受限任务：push 带空 hooks 目录与 --no-verify，扫描用的 diff 带 --text / --no-textconv', async () => {
    const first = await reported();
    setPushGateRestrictedLookup(() => true);
    scriptRepo();
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({ ok: true });
    const push = fake.calls.find((call) => call.args.includes('push'));
    expect(push?.args).toEqual([
      '-c',
      expect.stringMatching(/^core\.hooksPath=.+fynvra-hooks-/),
      'push',
      '--no-verify',
      '-u',
      'origin',
      BRANCH,
    ]);
    expect(fake.commands()).toContain(
      `git diff --no-color --no-ext-diff --no-textconv --text --no-renames ${MB}..${HEAD}`
    );
    expect(fake.commands()).toContain(`git log --format=%an%n%ae%n%cn%n%ce%n%B ${MB}..${HEAD}`);
  });

  it('代码里出现与用户名相同的单词：不误报', async () => {
    const first = await reported();
    scriptRepo('+const alice = 1;\n', 'alice\nalice@example.com\nalice\nalice@example.com\nAdd\n');
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({ ok: true });
  });

  it.each([
    ['diff 含已知 key', `+const key = "${KNOWN}";\n`, 'Add toggle\n', KNOWN],
    ['提交信息含私钥块', '+x\n', `Add key\n-----BEGIN ${'PRIVATE'} KEY-----\nMIIE\n`, 'MIIE'],
    ['提交作者含已知 key', '+x\n', `${KNOWN}\na@b.c\nme\na@b.c\nAdd\n`, KNOWN],
  ])('%s：拒绝，错误里不含该值', async (_label, diff, log, value) => {
    const first = await reported();
    scriptRepo(diff, log);
    const result = await host.openPullRequest(input(first.dispatch.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('secrets') });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(pushedOrGh(0)).toEqual([]);
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });

  it('PR 文本含本机路径：拒绝', async () => {
    const first = await reported();
    scriptRepo();
    const result = await host.openPullRequest({
      ...input(first.dispatch.id),
      summary: 'Log is at /home/alice/x.log',
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('local machine info (path'),
    });
    expect(JSON.stringify(result)).not.toContain('/home/alice');
    expect(pushedOrGh(0)).toEqual([]);
  });

  it('前置条件：不是 in-review、worktree 不干净、参数非法都拒绝', async () => {
    const pending = await host.dispatchTask({
      title: 'A',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [],
    });
    const pendingId = pending.ok ? (pending.dispatch?.id ?? '') : '';
    expect(await host.openPullRequest(input(pendingId))).toMatchObject({
      ok: false,
      error: expect.stringContaining('still in progress'),
    });
    const first = await reported();
    scriptRepo();
    expect(
      await host.openPullRequest({ ...input(first.dispatch.id), title: 'a\nb' })
    ).toMatchObject({ ok: false, error: 'title must be a single line' });
    expect(
      await host.openPullRequest({ ...input(first.dispatch.id), base: '-evil' })
    ).toMatchObject({ ok: false, error: 'base must be a valid branch name' });
    fake.respond(({ args }) => (args[0] === 'status' ? { stdout: ' M src/a.ts\n' } : undefined));
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({
      ok: false,
      error: expect.stringContaining('uncommitted'),
    });
    expect(pushedOrGh(0)).toEqual([]);
  });

  it('普通目录（in-place）：返回错误', async () => {
    host = makeHost({ workspace: { ...WORKSPACE, vcs: 'none' } });
    const first = await reported();
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({
      ok: false,
      error: expect.stringContaining('git workspace'),
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });

  it('清理：HEAD 等于已推送提交时删 worktree、保留本地分支；HEAD 移动后拒绝', async () => {
    const first = await reported();
    scriptRepo();
    expect(await host.openPullRequest(input(first.dispatch.id))).toMatchObject({ ok: true });
    fake.respond(({ args }) =>
      args[0] === 'rev-list' && args[1] === '--left-right' ? { stdout: '0\t1\n' } : undefined
    );
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('unmerged-commits'),
    });
    fake.respond(({ args }) =>
      args[0] === 'rev-list' && args[1] === '--left-right' ? { stdout: '0\t0\n' } : undefined
    );
    const start = fake.calls.length;
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      removedWorktree: true,
      deletedBranch: false,
    });
    const commands = fake.commands().slice(start);
    expect(commands).toContain(`git rev-parse --verify --quiet ${HEAD}^{commit}`);
    expect(commands.some((line) => line.startsWith('git branch'))).toBe(false);
  });
});
