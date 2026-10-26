import type { DispatchTaskOutput, OrchestrationHost } from '@fynvra/agent-runtime';
import { GitWorktreeManager, Inbox, InMemoryOrchestrationStore } from '@fynvra/core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  createOrchestrationHost,
  HOST_SENDER,
  type OrchestrationHostDeps,
  type RunChecksFn,
} from './host';
import {
  BASE_COMMIT,
  createFakeExec,
  createFakeLauncher,
  createFakeRoles,
  type FakeExec,
  type FakeLauncher,
  MERGE_COMMIT,
} from './testing';
import { createWorkerHost } from './workerHost';

const COORDINATOR = 'session_coord';
const WORKSPACE = {
  id: 'ws_1',
  name: 'demo',
  repoPath: '/repo',
  vcs: 'git' as const,
  defaultBranch: 'main',
};
const ROOT = '/data/worktrees';
const WORKTREE_PATH = `${ROOT}/ws_1/add-toggle`;

let store: InMemoryOrchestrationStore;
let inbox: Inbox;
let fake: FakeExec;
let launcher: FakeLauncher;
let runChecks: Mock<RunChecksFn>;
let host: OrchestrationHost;

function makeHost(overrides: Partial<OrchestrationHostDeps> = {}): OrchestrationHost {
  return createOrchestrationHost({
    workspace: WORKSPACE,
    coordinatorSessionId: COORDINATOR,
    coordinatorBranch: 'main',
    store,
    git: new GitWorktreeManager({ exec: fake.exec }),
    inbox,
    launcher,
    roles: createFakeRoles(),
    runChecks,
    resolveWorktreesRoot: async () => ROOT,
    exec: fake.exec,
    now: () => 1000,
    ...overrides,
  });
}

beforeEach(() => {
  store = new InMemoryOrchestrationStore();
  inbox = new Inbox({ messages: store.messages });
  fake = createFakeExec();
  launcher = createFakeLauncher();
  runChecks = vi.fn(async () => ({ exitCode: 0, output: 'all good', durationMs: 7 }));
  host = makeHost();
});

type Dispatched = DispatchTaskOutput & { dispatch: NonNullable<DispatchTaskOutput['dispatch']> };

async function dispatch(title = 'Add toggle', roleId = 'worker'): Promise<Dispatched> {
  const result = await host.dispatchTask({
    title,
    spec: '## Change\nDo it.',
    roleId,
    dependsOn: [],
  });
  if (!result.ok || result.dispatch === undefined) throw new Error(JSON.stringify(result));
  return result as Dispatched;
}

/** worker 侧的 WorkerHost（与 Main 里按 dispatch 绑定的一样）。 */
function worker(dispatchId: string) {
  const runId = store.tasks.get(store.dispatches.get(dispatchId)?.taskId ?? '')?.runId ?? '';
  return createWorkerHost({ store, inbox, runId, dispatchId });
}

async function reported(title = 'Add toggle'): Promise<Dispatched> {
  const result = await dispatch(title);
  expect(await worker(result.dispatch.id).reportDone('succeeded', 'Done.')).toEqual({ ok: true });
  return result;
}

const commandsSince = (start: number) => fake.commands().slice(start);

describe('dispatchTask', () => {
  it('依赖已满足：建 worktree → 任务书 → 起 worker 会话 → 记 Run / Task / Dispatch / Worktree', async () => {
    const result = await dispatch();

    expect(fake.commands()).toEqual([
      'git rev-parse --verify --quiet main^{commit}',
      'git for-each-ref --format=%(refname) refs/heads/fynvra/',
      `git worktree add --quiet -b fynvra/add-toggle -- ${WORKTREE_PATH} ${BASE_COMMIT}`,
    ]);
    expect(fake.calls.every((call) => call.cwd === '/repo')).toBe(true);

    const [run] = store.runs.list();
    const [worktree] = store.worktrees.list();
    expect(run).toMatchObject({
      workspaceId: 'ws_1',
      coordinatorSessionId: COORDINATOR,
      objective: 'Add toggle',
      createdAt: 1000,
    });
    expect(worktree).toMatchObject({
      workspaceId: 'ws_1',
      path: WORKTREE_PATH,
      branch: 'fynvra/add-toggle',
      baseRef: 'main',
      baseCommit: BASE_COMMIT,
    });
    expect(launcher.created()).toEqual([
      {
        workspaceId: 'ws_1',
        runId: run?.id,
        dispatchId: result.dispatch.id,
        roleId: 'worker',
        cwd: WORKTREE_PATH,
        worktreeId: worktree?.id,
        brief: expect.stringContaining(`# Add toggle\n\nDispatch: \`${result.dispatch.id}\``),
      },
    ]);
    expect(launcher.created()[0]?.brief).toContain('## Change\n\nDo it.');

    expect(result.task).toMatchObject({ runId: run?.id, status: 'in-progress', roleId: 'worker' });
    expect(result.dispatch).toEqual({
      id: result.dispatch.id,
      taskId: result.task.id,
      workerSessionId: 'session_w1',
      worktreeId: worktree?.id,
      branch: 'fynvra/add-toggle',
      startedAt: 1000,
    });
    expect(store.tasks.get(result.task.id)).toEqual(result.task);
    expect(store.dispatches.get(result.dispatch.id)).toEqual(result.dispatch);
  });

  it('同一个主 agent 的任务共用一个 Run；指定的自定义角色传给 launcher', async () => {
    await dispatch('First');
    await dispatch('Second', 'tester');
    expect(store.runs.list()).toHaveLength(1);
    expect(launcher.created().map((input) => input.roleId)).toEqual(['worker', 'tester']);
  });

  it.each([
    [{ roleId: 'nobody' }, /unknown role "nobody"/],
    [{ roleId: 'orchestrator' }, /orchestrator role/],
    [{ title: '   ' }, /title/],
    [{ spec: '' }, /spec/],
    [{ dependsOn: ['task_missing'] }, /unknown task "task_missing"/],
  ])('拒绝非法入参 %j，不碰 git 也不写 store', async (patch, error) => {
    const result = await host.dispatchTask({
      title: 'T',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [],
      ...patch,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(error) });
    expect(fake.calls).toEqual([]);
    expect(store.tasks.list()).toEqual([]);
  });

  it('依赖未完成：只建 todo 任务排队，不建 worktree、不返回 dispatch', async () => {
    const first = await dispatch('First');
    const queued = await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'tester',
      dependsOn: [first.task.id, first.task.id],
    });
    expect(queued).toMatchObject({
      ok: true,
      task: { status: 'todo', dependsOn: [first.task.id] },
    });
    expect(queued.ok && queued.dispatch).toBeUndefined();
    expect(launcher.createWorkerSession).toHaveBeenCalledTimes(1);
    expect(store.worktrees.list()).toHaveLength(1);
  });

  it('依赖已被放弃时拒绝派发', async () => {
    const first = await dispatch('First');
    await host.cleanupWorktree({ dispatchId: first.dispatch.id });
    const result = await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('abandoned') });
  });

  it.each([
    [
      '返回失败',
      () => launcher.createWorkerSession.mockResolvedValueOnce({ ok: false, error: 'no model' }),
    ],
    ['抛异常', () => launcher.createWorkerSession.mockRejectedValueOnce(new Error('no model'))],
  ])(
    'worker 会话起不来（%s）：回滚刚建的 worktree 与分支，store 里不留任务',
    async (_label, arrange) => {
      arrange();
      const result = await host.dispatchTask({
        title: 'Add toggle',
        spec: 'S',
        roleId: 'worker',
        dependsOn: [],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('no model') });
      expect(fake.commands().slice(-2)).toEqual([
        `git worktree remove --force -- ${WORKTREE_PATH}`,
        'git branch -D fynvra/add-toggle',
      ]);
      expect(store.tasks.list()).toEqual([]);
      expect(store.dispatches.list()).toEqual([]);
      expect(store.worktrees.list()).toEqual([]);
    }
  );

  it('建 worktree 失败：不起会话，返回 git 的错误', async () => {
    fake.respond(({ args }) =>
      args[0] === 'worktree' && args[1] === 'add'
        ? { code: 128, stderr: 'fatal: disk full' }
        : undefined
    );
    const result = await host.dispatchTask({
      title: 'Add toggle',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [],
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('fatal: disk full') });
    expect(launcher.createWorkerSession).not.toHaveBeenCalled();
    expect(store.tasks.list()).toEqual([]);
  });

  it('依赖异常（如角色仓库抛错）也返回错误结果而不是抛出', async () => {
    const roles = createFakeRoles();
    roles.get = async () => {
      throw new Error('roles dir unreadable');
    };
    const result = await makeHost({ roles }).dispatchTask({
      title: 'T',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [],
    });
    expect(result).toEqual({ ok: false, error: 'roles dir unreadable' });
  });
});

describe('listWorkers 与排队派发', () => {
  it('列出本 Run 的任务及当前 dispatch；排队任务在依赖合并后被补派', async () => {
    const first = await dispatch('First');
    const queued = await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'tester',
      dependsOn: [first.task.id],
    });
    const queuedId = queued.ok ? queued.task.id : '';

    let listed = await host.listWorkers();
    expect(
      listed.ok && listed.workers.map((w) => [w.task.title, w.task.status, w.dispatch?.id])
    ).toEqual([
      ['First', 'in-progress', first.dispatch.id],
      ['Second', 'todo', undefined],
    ]);

    await worker(first.dispatch.id).reportDone('succeeded', 'Done.');
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      merged: true,
    });
    // 合并即补派（主 agent 不再阻塞等待，不会马上回来调 list/wait）
    expect(launcher.createWorkerSession).toHaveBeenCalledTimes(2);

    listed = await host.listWorkers();
    const second = listed.ok ? listed.workers[1] : undefined;
    expect(second?.task).toMatchObject({ id: queuedId, status: 'in-progress' });
    expect(second?.dispatch?.workerSessionId).toBe('session_w2');
    expect(launcher.created()[1]).toMatchObject({ roleId: 'tester' });
  });

  it('依赖被放弃：排队任务随之放弃，并给主 agent 投 escalation', async () => {
    const first = await dispatch('First');
    const queued = await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    await host.cleanupWorktree({ dispatchId: first.dispatch.id });
    await host.listWorkers();

    expect(queued.ok && store.tasks.get(queued.task.id)?.status).toBe('abandoned');
    const [escalation] = inbox.peek({ to: COORDINATOR, types: ['escalation'] });
    expect(escalation).toMatchObject({ from: HOST_SENDER, subject: 'queued task abandoned' });
    expect(escalation?.body).toContain(first.task.id);
  });

  it('排队任务启动失败：放弃并上报原因，不会每次调用都重试', async () => {
    const first = await dispatch('First');
    await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    await worker(first.dispatch.id).reportDone('succeeded', 'Done.');

    launcher.createWorkerSession.mockResolvedValueOnce({ ok: false, error: 'quota exceeded' });
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    await host.listWorkers();
    await host.listWorkers();
    expect(launcher.createWorkerSession).toHaveBeenCalledTimes(2);
    const [escalation] = inbox.peek({ to: COORDINATOR, types: ['escalation'] });
    expect(escalation?.body).toContain('quota exceeded');
  });

  it('看不到其他主 agent 的 Run', async () => {
    await dispatch();
    const other = makeHost({ coordinatorSessionId: 'session_other' });
    expect(await other.listWorkers()).toEqual({ ok: true, workers: [] });
  });
});

describe('waitForWorkers', () => {
  it('没有运行中的 worker 时立即返回', async () => {
    expect(await host.waitForWorkers({ timeoutMs: 60_000, until: 'all' })).toEqual({
      ok: true,
      timedOut: false,
      messages: [],
      pending: 0,
    });
  });

  it("until 'any'：第一条 worker_done 到达就返回，消息被确认", async () => {
    const first = await dispatch('First');
    await dispatch('Second');
    const waiting = host.waitForWorkers({ timeoutMs: 60_000, until: 'any' });
    await worker(first.dispatch.id).reportDone('succeeded', 'First done.');
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, timedOut: false, pending: 1 });
    expect(result.ok && result.messages.map((m) => [m.type, m.dispatchId])).toEqual([
      ['worker_done', first.dispatch.id],
    ]);
    expect(inbox.peek({ to: COORDINATOR })).toEqual([]);
  });

  it("until 'all'：等所有运行中的 dispatch 结算，返回期间送达的全部消息", async () => {
    const first = await dispatch('First');
    const second = await dispatch('Second');
    const waiting = host.waitForWorkers({ timeoutMs: 60_000, until: 'all' });
    await worker(first.dispatch.id).reportDone('succeeded', 'First done.');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker(second.dispatch.id).reportDone('failed', 'Second failed.');
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, timedOut: false, pending: 0 });
    expect(result.ok && result.messages.map((m) => m.subject)).toEqual(['succeeded', 'failed']);
  });

  it('question 一到就返回（即使还有 worker 在跑）', async () => {
    const first = await dispatch();
    const waiting = host.waitForWorkers({ timeoutMs: 60_000, until: 'all' });
    const asking = worker(first.dispatch.id).askCoordinator('Which API?', 60_000);
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, timedOut: false, pending: 1 });
    expect(result.ok && result.messages.map((m) => m.type)).toEqual(['question']);

    expect(await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'v2' })).toMatchObject({
      ok: true,
      type: 'reply',
    });
    expect(await asking).toEqual({ ok: true, answer: 'v2' });
  });

  it('超时返回 timedOut: true，不是错误', async () => {
    await dispatch();
    expect(await host.waitForWorkers({ timeoutMs: 30, until: 'all' })).toEqual({
      ok: true,
      timedOut: true,
      messages: [],
      pending: 1,
    });
  });

  it('signal 中止时返回错误，期间收到的消息不被确认', async () => {
    const first = await dispatch();
    const controller = new AbortController();
    const waiting = host.waitForWorkers({ timeoutMs: 60_000, until: 'all' }, controller.signal);
    inbox.post({
      runId: store.runs.list()[0]?.id ?? '',
      dispatchId: first.dispatch.id,
      from: 'session_w1',
      to: COORDINATOR,
      type: 'heartbeat',
      body: 'still here',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await waiting).toEqual({ ok: false, error: 'wait_for_workers was aborted' });
    expect(inbox.peek({ to: COORDINATOR, types: ['heartbeat'] })).toHaveLength(1);
  });
});

describe('readWorkerOutput', () => {
  it('透传 launcher.readTranscript；尝试结算后 done 才为 true', async () => {
    const first = await dispatch();
    launcher.readTranscript.mockResolvedValue({ ok: true, text: 'cdef', total: 6, done: true });
    expect(await host.readWorkerOutput({ dispatchId: first.dispatch.id, cursor: 2 })).toEqual({
      ok: true,
      text: 'cdef',
      total: 6,
      done: false,
    });
    expect(launcher.readTranscript).toHaveBeenCalledWith('session_w1', 2);
    await worker(first.dispatch.id).reportDone('succeeded', 'Done.');
    expect(await host.readWorkerOutput({ dispatchId: first.dispatch.id, cursor: 2 })).toMatchObject(
      {
        done: true,
      }
    );
  });

  it('未知 / 其他 Run 的 dispatch、非法 cursor、launcher 失败都返回错误', async () => {
    const first = await dispatch();
    const other = makeHost({ coordinatorSessionId: 'session_other' });
    expect(
      await other.readWorkerOutput({ dispatchId: first.dispatch.id, cursor: 0 })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown dispatch_id'),
    });
    expect(
      await host.readWorkerOutput({ dispatchId: first.dispatch.id, cursor: -1 })
    ).toMatchObject({
      ok: false,
    });
    launcher.readTranscript.mockResolvedValueOnce({ ok: false, error: 'no such session' });
    expect(await host.readWorkerOutput({ dispatchId: first.dispatch.id, cursor: 0 })).toMatchObject(
      {
        ok: false,
        error: expect.stringContaining('no such session'),
      }
    );
  });
});

describe('sendToWorker', () => {
  it('worker 没有挂起的问题：记 instruction 并作为 prompt 发给 worker 会话', async () => {
    const first = await dispatch();
    const result = await host.sendToWorker({
      dispatchId: first.dispatch.id,
      body: ' Also update docs. ',
    });
    expect(result).toMatchObject({ ok: true, type: 'instruction' });
    expect(launcher.promptSession).toHaveBeenCalledWith(
      'session_w1',
      'Message from your coordinator:\n\nAlso update docs.'
    );
    const message = result.ok ? store.messages.get(result.messageId) : undefined;
    expect(message).toMatchObject({
      type: 'instruction',
      from: COORDINATOR,
      to: 'session_w1',
      dispatchId: first.dispatch.id,
      body: 'Also update docs.',
    });
    expect(message?.ackedAt).toBeDefined();
  });

  it('投递失败时撤回 instruction 并返回错误', async () => {
    const first = await dispatch();
    launcher.promptSession.mockResolvedValueOnce({ ok: false, error: 'session gone' });
    expect(await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'hi' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('session gone'),
    });
    expect(store.messages.list((m) => m.type === 'instruction')).toEqual([]);
  });

  it('worker 正阻塞在 ask_coordinator：发 reply 唤醒它，问题被确认，不另发 prompt', async () => {
    const first = await dispatch();
    const asking = worker(first.dispatch.id).askCoordinator('Which API?', 60_000);
    const [question] = inbox.peek({ to: COORDINATOR, types: ['question'] });
    const result = await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'Use v2.' });
    expect(result).toMatchObject({ ok: true, type: 'reply' });
    expect(result.ok && store.messages.get(result.messageId)).toMatchObject({
      type: 'reply',
      replyTo: question?.id,
      to: 'session_w1',
    });
    expect(await asking).toEqual({ ok: true, answer: 'Use v2.' });
    expect(store.messages.get(question?.id ?? '')?.ackedAt).toBeDefined();
    expect(launcher.promptSession).not.toHaveBeenCalled();
  });

  it('已完成的任务不再接收指示', async () => {
    const first = await reported();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    expect(await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'more' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('completed'),
    });
  });
});

describe('reviewDiff 与 runChecks', () => {
  it('reviewDiff：baseCommit...HEAD 的文件、stat 与 diff（在 worktree 里执行）', async () => {
    const first = await dispatch();
    const start = fake.calls.length;
    expect(await host.reviewDiff({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      branch: 'fynvra/add-toggle',
      baseCommit: BASE_COMMIT,
      files: ['src/a.ts'],
      stat: ' src/a.ts | 1 +\n 1 file changed',
      diff: 'diff --git a/src/a.ts\n+x\n',
    });
    expect(commandsSince(start)).toEqual([
      `git diff --name-only -z ${BASE_COMMIT}...HEAD`,
      `git -c core.quotepath=false diff --no-color --no-ext-diff ${BASE_COMMIT}...HEAD`,
      `git -c core.quotepath=false diff --stat=200 --no-color ${BASE_COMMIT}...HEAD`,
    ]);
    expect(fake.calls.slice(start).every((call) => call.cwd === WORKTREE_PATH)).toBe(true);
  });

  it('runChecks：白名单外的命令被拒绝，不会执行', async () => {
    const first = await dispatch();
    const result = await host.runChecks({ dispatchId: first.dispatch.id, command: 'rm -rf /' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('"rm"') });
    expect(runChecks).not.toHaveBeenCalled();
  });

  it('runChecks：放行的命令在 worktree 里执行，透传退出码与输出', async () => {
    const first = await dispatch();
    const controller = new AbortController();
    runChecks.mockResolvedValueOnce({ exitCode: 1, output: 'FAIL', durationMs: 42 });
    expect(
      await host.runChecks(
        { dispatchId: first.dispatch.id, command: ' pnpm typecheck && pnpm test ' },
        controller.signal
      )
    ).toEqual({ ok: true, exitCode: 1, output: 'FAIL', durationMs: 42 });
    expect(runChecks).toHaveBeenCalledWith(
      WORKTREE_PATH,
      'pnpm typecheck && pnpm test',
      controller.signal
    );
  });

  it('runChecks 抛异常时返回错误结果', async () => {
    const first = await dispatch();
    runChecks.mockRejectedValueOnce(new Error('spawn failed'));
    expect(await host.runChecks({ dispatchId: first.dispatch.id, command: 'pnpm test' })).toEqual({
      ok: false,
      error: 'spawn failed',
    });
  });
});

describe('mergeWorktree', () => {
  it('in-review：确认 worktree 干净、仓库在目标分支后 --no-ff 合并，task → completed', async () => {
    const first = await reported();
    const start = fake.calls.length;
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      merged: true,
      targetBranch: 'main',
      commit: MERGE_COMMIT,
    });
    expect(commandsSince(start)).toEqual([
      'git status --porcelain',
      'git rev-parse --verify --quiet main^{commit}',
      `git rev-list --left-right --count ${BASE_COMMIT}...HEAD`,
      'git symbolic-ref --quiet --short HEAD',
      'git merge --no-ff --no-edit fynvra/add-toggle',
      'git rev-parse HEAD',
    ]);
    expect(fake.calls.slice(start).map((call) => call.cwd)).toEqual([
      WORKTREE_PATH,
      WORKTREE_PATH,
      WORKTREE_PATH,
      '/repo',
      '/repo',
      '/repo',
    ]);
    expect(store.tasks.get(first.task.id)?.status).toBe('completed');
    expect(store.dispatches.get(first.dispatch.id)).toMatchObject({ outcome: 'succeeded' });
  });

  it('合并完成后推进排队任务：依赖完成的 queued 任务随即启动 worker', async () => {
    const first = await dispatch('First');
    const queued = await host.dispatchTask({
      title: 'Second',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    expect(queued).toMatchObject({ ok: true, task: { status: 'todo' } });
    expect(await worker(first.dispatch.id).reportDone('succeeded', 'Done.')).toEqual({ ok: true });

    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: true,
      merged: true,
    });

    const second = queued.ok ? queued.task.id : '';
    expect(store.tasks.get(second)?.status).toBe('in-progress');
    expect(launcher.createWorkerSession).toHaveBeenCalledTimes(2);
    expect(store.dispatches.list((dispatch) => dispatch.taskId === second)).toHaveLength(1);
  });

  it('worker 还没汇报时拒绝合并', async () => {
    const first = await dispatch();
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('wait_for_workers'),
    });
    expect(fake.commands().some((command) => command.startsWith('git merge'))).toBe(false);
  });

  it('worktree 有未提交改动：要求 worker 先提交，不合并', async () => {
    const first = await reported();
    fake.respond(({ args }) => (args[0] === 'status' ? { stdout: ' M src/a.ts\n' } : undefined));
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('uncommitted'),
    });
    expect(fake.commands().some((command) => command.startsWith('git merge'))).toBe(false);
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });

  it.each([
    ['在别的分支', { stdout: 'feature\n' }, 'branch feature'],
    ['detached HEAD', { code: 1, stdout: '' }, 'detached HEAD'],
  ])('仓库%s：拒绝合并', async (_label, response, error) => {
    const first = await reported();
    fake.respond(({ args }) => (args[0] === 'symbolic-ref' ? response : undefined));
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining(error),
    });
    expect(fake.commands().some((command) => command.startsWith('git merge'))).toBe(false);
  });

  it('冲突：返回冲突文件（git 已 merge --abort），task 仍待验收', async () => {
    const first = await reported();
    fake.respond(({ args }) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') return { code: 1, stdout: 'CONFLICT' };
      if (args.includes('--diff-filter=U')) return { stdout: 'src/a.ts\0' };
      return undefined;
    });
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      merged: false,
      targetBranch: 'main',
      conflicts: ['src/a.ts'],
    });
    expect(fake.commands()).toContain('git merge --abort');
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });
});

describe('rejectWork', () => {
  it('in-review → in-progress：同一 worktree / 会话上新建一次尝试，反馈作为新 prompt 发出', async () => {
    const first = await reported();
    const result = await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'Add tests.' });
    expect(result).toMatchObject({ ok: true });

    const active = store.activeDispatch(first.task.id);
    expect(active).toMatchObject({
      workerSessionId: 'session_w1',
      worktreeId: first.dispatch.worktreeId,
      branch: 'fynvra/add-toggle',
    });
    expect(active?.id).not.toBe(first.dispatch.id);
    expect(store.dispatches.get(first.dispatch.id)?.outcome).toBe('succeeded');
    expect(store.tasks.get(first.task.id)?.status).toBe('in-progress');

    const message = result.ok ? store.messages.get(result.messageId) : undefined;
    expect(message).toMatchObject({
      type: 'instruction',
      subject: 'review feedback',
      dispatchId: active?.id,
      to: 'session_w1',
      body: 'Add tests.',
    });
    const [sessionId, prompt] = launcher.promptSession.mock.calls[0] ?? [];
    expect(sessionId).toBe('session_w1');
    expect(prompt).toContain('Add tests.');
    expect(prompt).toContain(active?.id);
    expect(prompt).toContain('report_done');

    // worker 在新的一轮里再次汇报，结算的是新尝试
    expect(await worker(active?.id ?? '').reportDone('succeeded', 'Tests added.')).toEqual({
      ok: true,
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
  });

  it('报告失败的任务也可以打回重试', async () => {
    const first = await dispatch();
    await worker(first.dispatch.id).reportDone('failed', 'Stuck.');
    expect(
      await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'Try X.' })
    ).toMatchObject({
      ok: true,
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('in-progress');
  });

  it('反馈投递失败：撤回新尝试与消息，task 回到 in-review', async () => {
    const first = await reported();
    launcher.promptSession.mockResolvedValueOnce({ ok: false, error: 'session gone' });
    expect(
      await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'Fix.' })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('session gone'),
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('in-review');
    expect(store.activeDispatch(first.task.id)).toBeUndefined();
    expect(store.dispatches.list()).toHaveLength(1);
    expect(store.messages.list((m) => m.type === 'instruction')).toEqual([]);
  });

  it('worker 还在干活时拒绝打回', async () => {
    const first = await dispatch();
    expect(await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('send_to_worker'),
    });
  });
});

describe('cleanupWorktree', () => {
  it('已合并：关闭 worker 会话、强删 worktree、-d 删分支，从 store 删除 worktree', async () => {
    const first = await reported();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    const start = fake.calls.length;
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      removedWorktree: true,
      deletedBranch: true,
    });
    expect(launcher.disposeSession).toHaveBeenCalledWith('session_w1');
    expect(commandsSince(start)).toEqual([
      `git worktree remove --force -- ${WORKTREE_PATH}`,
      'git branch -d fynvra/add-toggle',
    ]);
    expect(store.worktrees.list()).toEqual([]);
    expect(store.tasks.get(first.task.id)?.status).toBe('completed');
    expect(store.reclaimableDispatches(first.task.runId)).toEqual([]);
  });

  it('未完成的任务：结算进行中的尝试为 failed、task → abandoned，分支连同提交 -D 删除', async () => {
    const first = await dispatch();
    const start = fake.calls.length;
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: true,
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('abandoned');
    expect(store.dispatches.get(first.dispatch.id)).toMatchObject({
      outcome: 'failed',
      settledAt: 1000,
      summary: expect.stringContaining('Abandoned'),
    });
    expect(commandsSince(start)).toContain('git branch -D fynvra/add-toggle');
  });

  it('删 worktree 失败：返回错误并保留记录，可以重试；清理过的 dispatch 再清理报错', async () => {
    const first = await reported();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    fake.respond(({ args }) =>
      args[0] === 'worktree' && args[1] === 'remove' ? { code: 1, stderr: 'locked' } : undefined
    );
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('locked'),
    });
    expect(store.worktrees.list()).toHaveLength(1);

    fake.respond(({ args }) => (args[0] === 'worktree' && args[1] === 'remove' ? {} : undefined));
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: true,
    });
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already cleaned up'),
    });
    expect(await host.reviewDiff({ dispatchId: first.dispatch.id })).toMatchObject({ ok: false });
  });

  it('分支删不掉时 deletedBranch: false，worktree 照常清理', async () => {
    const first = await reported();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    fake.respond(({ args }) =>
      args[0] === 'branch' ? { code: 1, stderr: 'not merged' } : undefined
    );
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      removedWorktree: true,
      deletedBranch: false,
    });
  });
});

describe('普通目录（vcs: none）：原地编排，不调用 git', () => {
  const PLAIN = { id: 'ws_1', name: 'notes', repoPath: '/notes', vcs: 'none' as const };
  let resolveWorktreesRoot: Mock<OrchestrationHostDeps['resolveWorktreesRoot']>;

  beforeEach(() => {
    resolveWorktreesRoot = vi.fn(async () => ROOT);
    host = makeHost({ workspace: PLAIN, coordinatorBranch: '', resolveWorktreesRoot });
  });

  /** 整个用例里都没有跑过 git，也没有算 worktree 根目录 */
  const expectNoGit = () => {
    expect(fake.calls).toEqual([]);
    expect(resolveWorktreesRoot).not.toHaveBeenCalled();
    expect(store.worktrees.list()).toEqual([]);
  };

  it('dispatch：worker 的 cwd 是工作区目录，没有 worktree；Dispatch 记 in-place', async () => {
    const result = await dispatch();
    expect(result.dispatch).toMatchObject({
      worktreeId: '',
      branch: '',
      mode: 'in-place',
      workerSessionId: 'session_w1',
    });
    const [created] = launcher.created();
    expect(created).toMatchObject({ cwd: '/notes', roleId: 'worker' });
    expect(created).not.toHaveProperty('worktreeId');
    expect(created?.brief).toContain('report_done');
    expect(store.tasks.get(result.task.id)?.status).toBe('in-progress');
    expectNoGit();
  });

  it('并行派发的任务共用同一个目录', async () => {
    const first = await dispatch('One');
    const second = await dispatch('Two');
    expect(launcher.created().map((input) => input.cwd)).toEqual(['/notes', '/notes']);
    expect([first.dispatch.mode, second.dispatch.mode]).toEqual(['in-place', 'in-place']);
    expectNoGit();
  });

  it('会话起不来：返回错误，没有 worktree 要回滚', async () => {
    launcher.createWorkerSession.mockResolvedValueOnce({ ok: false, error: 'no model' });
    expect(
      await host.dispatchTask({ title: 'Doomed', spec: 'S', roleId: 'worker', dependsOn: [] })
    ).toMatchObject({ ok: false, error: 'could not start the worker session: no model' });
    expect(store.dispatches.list()).toEqual([]);
    expectNoGit();
  });

  it('review：没有 diff，给出本任务各次尝试汇报的改动文件', async () => {
    const first = await dispatch();
    const empty = { ok: true, branch: '', baseCommit: '', stat: '', diff: '', mode: 'in-place' };
    expect(await host.reviewDiff({ dispatchId: first.dispatch.id })).toEqual({
      ...empty,
      files: [],
    });
    await worker(first.dispatch.id).reportDone('succeeded', 'Done.', ['hello.txt', 'a.md']);
    await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'Also b.md.' });
    const retry = store.activeDispatch(first.task.id);
    await worker(retry?.id ?? '').reportDone('succeeded', 'Added b.md.', ['b.md', 'a.md']);
    expect(await host.reviewDiff({ dispatchId: retry?.id ?? '' })).toEqual({
      ...empty,
      files: ['hello.txt', 'a.md', 'b.md'],
    });
    expectNoGit();
  });

  it('run_checks：在工作区目录里跑；白名单照常生效', async () => {
    const first = await dispatch();
    expect(
      await host.runChecks({ dispatchId: first.dispatch.id, command: 'pnpm test' })
    ).toMatchObject({ ok: true, exitCode: 0 });
    expect(runChecks).toHaveBeenCalledWith('/notes', 'pnpm test', undefined);
    expect(
      await host.runChecks({ dispatchId: first.dispatch.id, command: 'rm -rf .' })
    ).toMatchObject({ ok: false });
    expect(runChecks).toHaveBeenCalledTimes(1);
  });

  it('merge：无需合并，待验收的任务直接 completed；没汇报的不收', async () => {
    const pending = await dispatch('Pending');
    expect(await host.mergeWorktree({ dispatchId: pending.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('still in progress'),
    });
    const first = await reported();
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toEqual({
      ok: true,
      merged: true,
      targetBranch: '',
      mode: 'in-place',
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('completed');
    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already accepted'),
    });
    expectNoGit();
  });

  it('cleanup：无需清理，只停 worker；已完成的保持 completed，可以重复调用', async () => {
    const first = await reported();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    const cleaned = { ok: true, removedWorktree: false, deletedBranch: false, mode: 'in-place' };
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toEqual(cleaned);
    expect(launcher.disposeSession).toHaveBeenCalledWith('session_w1');
    expect(store.tasks.get(first.task.id)?.status).toBe('completed');
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toEqual(cleaned);
    expectNoGit();
  });

  it('cleanup 未完成的任务：放弃（进行中的尝试结算为 failed），改动留在目录里', async () => {
    const first = await dispatch();
    expect(await host.cleanupWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      ok: true,
      mode: 'in-place',
    });
    expect(store.tasks.get(first.task.id)?.status).toBe('abandoned');
    expect(store.dispatches.get(first.dispatch.id)).toMatchObject({ outcome: 'failed' });
    expect(await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'hi' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('abandoned'),
    });
    expectNoGit();
  });

  it('打回：同一会话、同一目录上的新尝试，反馈里不叫 worker 提交', async () => {
    const first = await reported();
    expect(
      await host.rejectWork({ dispatchId: first.dispatch.id, feedback: 'Add tests.' })
    ).toMatchObject({ ok: true });
    expect(store.activeDispatch(first.task.id)).toMatchObject({
      workerSessionId: 'session_w1',
      worktreeId: '',
      branch: '',
      mode: 'in-place',
    });
    const [, prompt] = launcher.promptSession.mock.calls[0] ?? [];
    expect(prompt).toContain('Add tests.');
    expect(prompt).toContain('workspace directory');
    expect(prompt).not.toContain('commit your changes');
    expectNoGit();
  });

  it('send_to_worker：没有 worktree 也照常投递指示', async () => {
    const first = await dispatch();
    expect(
      await host.sendToWorker({ dispatchId: first.dispatch.id, body: 'Use tabs.' })
    ).toMatchObject({ ok: true, type: 'instruction' });
    expect(launcher.promptSession).toHaveBeenCalledWith(
      'session_w1',
      expect.stringContaining('Use tabs.')
    );
  });

  it('依赖：排队的任务在前一个验收后原地补派', async () => {
    const first = await reported('Base');
    const queued = await host.dispatchTask({
      title: 'On top',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    expect(queued.ok && queued.dispatch).toBeUndefined();
    await host.mergeWorktree({ dispatchId: first.dispatch.id });
    const listed = await host.listWorkers();
    expect(listed.ok && listed.workers[1]?.dispatch).toMatchObject({ mode: 'in-place' });
    expect(launcher.created().map((input) => input.cwd)).toEqual(['/notes', '/notes']);
    expectNoGit();
  });
});
