import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { JsonFileRoleStore, type Workspace } from '@fynvra/core';
import type { SessionEventEnvelope } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenSession } from '../../../agent/supervisor';
import { createOrchestrationRegistry } from '../orchestration/registry';
import { createModelResolver } from '../providers/resolveModel';
import { createSessionStore } from '../sessions/sessionStore';
import { type AgentHostService, createAgentHost } from './agentHost';
import { connectOrchestration } from './connectOrchestration';
import { InMemoryWorker, ScriptedSession } from './testing';

const hasGit = spawnSync('git', ['--version']).status === 0;
const execFileAsync = promisify(execFile);

// 真实 git 仓库 + worktree + 子进程，Windows 上较慢
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

type Result<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

/** 两个脚本会话一路记下的工具结果 */
interface Steps {
  dispatch?: Result<OrchestrationHost['dispatchTask']>;
  wait?: Result<OrchestrationHost['waitForWorkers']>;
  output?: Result<OrchestrationHost['readWorkerOutput']>;
  review?: Result<OrchestrationHost['reviewDiff']>;
  merge?: Result<OrchestrationHost['mergeWorktree']>;
  cleanup?: Result<OrchestrationHost['cleanupWorktree']>;
  brief?: string;
  report?: Result<WorkerHost['reportDone']>;
}

/**
 * Main 层端到端：真实的 AgentHost（经 InMemoryWorker 走两端协议 parser 到真实 SessionSupervisor）、
 * 真实的编排注册表与 git、生产用的 createModelResolver，按 src/main/index.ts 同一个 connectOrchestration 接线。
 * 模型由脚本会话代替：orchestrator 依次调用编排工具，worker 在 worktree 里提交后 report_done。
 */
describe.skipIf(!hasGit)('agent host ⇄ orchestration（真实 git）', () => {
  let root: string;
  let repo: string;
  let userData: string;
  let agentHost: AgentHostService | undefined;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-wiring-it-')));
    repo = join(root, 'repo');
    userData = join(root, 'userData');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'fynvra-test');
    git(repo, 'config', 'user.email', 'test@fynvra.invalid');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# Demo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await agentHost?.shutdown(1_000);
    agentHost = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('dispatch_task → worker 提交并 report_done → wait_for_workers → review_diff → merge_worktree → cleanup_worktree', async () => {
    const steps: Steps = {};
    const openSession: OpenSession = async ({ spec, host, workerHost }) => {
      if (host) {
        return new ScriptedSession(async (_text, emit) => {
          steps.dispatch = await host.dispatchTask({
            title: 'Append README line',
            spec: '## Change\nAppend the line "Wired end to end." to README.md and commit it.',
            roleId: 'worker',
            dependsOn: [],
          });
          const dispatchId = steps.dispatch.ok ? steps.dispatch.dispatch?.id : undefined;
          if (dispatchId === undefined) return;
          steps.wait = await host.waitForWorkers({ timeoutMs: 60_000, until: 'all' });
          steps.output = await host.readWorkerOutput({ dispatchId, cursor: 0 });
          steps.review = await host.reviewDiff({ dispatchId });
          steps.merge = await host.mergeWorktree({ dispatchId });
          steps.cleanup = await host.cleanupWorktree({ dispatchId });
          emit({ type: 'text_delta', delta: 'Merged and cleaned up.' });
        });
      }
      if (workerHost) {
        return new ScriptedSession(async (text, emit) => {
          steps.brief = text;
          appendFileSync(join(spec.cwd, 'README.md'), 'Wired end to end.\n');
          await execFileAsync('git', ['add', 'README.md'], { cwd: spec.cwd });
          await execFileAsync('git', ['commit', '-q', '-m', 'docs: append a README line'], {
            cwd: spec.cwd,
          });
          emit({ type: 'text_delta', delta: 'Committed the README line.' });
          steps.report = await workerHost.reportDone('succeeded', 'Appended a line to README.md', [
            'README.md',
          ]);
        });
      }
      throw new Error(`unexpected session for role ${spec.role.id}`);
    };

    const workspace: Workspace = {
      id: 'ws_1',
      name: 'repo',
      repoPath: repo,
      vcs: 'git',
      defaultBranch: 'main',
    };
    const roles = new JsonFileRoleStore({ fs, dir: join(userData, 'roles') });
    const broadcasts: unknown[][] = [];
    const host = createAgentHost({
      fork: () => new InMemoryWorker(openSession),
      agentDir: join(userData, 'agent'),
      store: createSessionStore({ filePath: join(userData, 'sessions.json') }),
      workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
      roles,
      models: createModelResolver({
        list: async () => [
          {
            id: 'anthropic',
            name: 'Anthropic',
            api: 'anthropic-messages',
            enabled: true,
            models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
            apiKey: 'sk-e2e',
          },
        ],
      }),
      broadcast: (...args) => broadcasts.push(args),
      log: () => {},
    });
    agentHost = host;
    const registry = createOrchestrationRegistry({
      userDataPath: userData,
      listWorkspaces: () => [workspace],
      roles,
      notifyChanged: () => {},
      log: () => {},
    });
    await connectOrchestration(host, registry);
    host.start();

    const created = await host.create({ workspaceId: 'ws_1', roleId: 'orchestrator' });
    if (!created.ok) throw new Error(created.error);
    const coordinatorId = created.session.id;
    expect(await host.prompt(coordinatorId, 'Add a line to the README')).toEqual({ ok: true });
    const events = () =>
      broadcasts
        .filter(([channel]) => channel === IPC_CHANNELS.SESSIONS_EVENT)
        .map(([, envelope]) => envelope as SessionEventEnvelope)
        .filter((envelope) => envelope.sessionId === coordinatorId)
        .map((envelope) => envelope.event);
    await vi.waitFor(
      () => expect(events().some((event) => event.type === 'agent_settled')).toBe(true),
      { timeout: 90_000, interval: 50 }
    );

    // dispatch_task 接通：建了 worktree，起了以主 agent 为 parent 的 worker 会话
    const { dispatch: dispatched, wait, output, review, merge, cleanup } = steps;
    if (!dispatched?.ok || dispatched.dispatch === undefined) {
      throw new Error(`dispatch_task failed: ${JSON.stringify(dispatched)}`);
    }
    const attempt = dispatched.dispatch;
    expect(attempt.branch).toBe('fynvra/append-readme-line');
    // 没配置 worktreesRoot：建在仓库同级的 <仓库目录名>-worktrees 下
    const worktreePath = join(root, 'repo-worktrees', 'ws_1', 'append-readme-line');
    expect(
      host.list('ws_1').find((session) => session.id === attempt.workerSessionId)
    ).toMatchObject({
      roleId: 'worker',
      parentSessionId: coordinatorId,
      dispatchId: attempt.id,
      worktreeId: attempt.worktreeId,
      cwd: worktreePath,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
    });
    expect(steps.brief).toContain('report_done');
    expect(steps.report).toEqual({ ok: true });

    // wait_for_workers 收到 worker_done；worker 的输出经 launcher 的 transcript 读得到
    expect(wait).toMatchObject({ ok: true, timedOut: false, pending: 0 });
    expect(wait?.ok && wait.messages.map((message) => [message.type, message.from])).toEqual([
      ['worker_done', attempt.workerSessionId],
    ]);
    expect(output).toMatchObject({ ok: true, done: true });
    expect(output?.ok && output.text).toContain('Committed the README line.');

    // review_diff → merge_worktree：main 收到 --no-ff 合并提交
    expect(review).toMatchObject({ ok: true, branch: attempt.branch, files: ['README.md'] });
    expect(review?.ok && review.diff).toContain('+Wired end to end.');
    expect(merge).toMatchObject({ ok: true, merged: true, targetBranch: 'main' });
    expect(merge?.ok && merge.commit).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
    expect(git(repo, 'show', 'main:README.md')).toBe('# Demo\nWired end to end.');

    // cleanup_worktree：worktree 目录、git 的 worktree 记录与分支都没了
    expect(cleanup).toEqual({ ok: true, removedWorktree: true, deletedBranch: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('append-readme-line');
    expect(git(repo, 'branch', '--list', 'fynvra/*')).toBe('');

    // 编排快照落盘：userData/orchestration/<workspaceId>.json
    const statePath = join(userData, 'orchestration', 'ws_1.json');
    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(saved.runs).toEqual([
        expect.objectContaining({ coordinatorSessionId: coordinatorId }),
      ]);
      expect(saved.tasks).toEqual([
        expect.objectContaining({ title: 'Append README line', status: 'completed' }),
      ]);
      expect(saved.dispatches).toEqual([
        expect.objectContaining({
          id: attempt.id,
          outcome: 'succeeded',
          summary: 'Appended a line to README.md',
        }),
      ]);
      expect(saved.worktrees).toEqual([]);
      expect(saved.messages).toEqual([
        expect.objectContaining({ type: 'worker_done', ackedAt: expect.any(Number) }),
      ]);
    });
  });
});
