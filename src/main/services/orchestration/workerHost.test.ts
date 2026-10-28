import { type Dispatch, Inbox, InMemoryOrchestrationStore, type Task } from '@fynvra/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkerHost, pendingQuestionOf, takePendingQuestion } from './workerHost';

const COORDINATOR = 'session_coordinator';
const WORKER = 'session_worker';

let store: InMemoryOrchestrationStore;
let inbox: Inbox;

function seedTask(status: Task['status'] = 'in-progress'): Task {
  const task: Task = {
    id: 'task_1',
    runId: 'run_1',
    title: 'Add toggle',
    spec: 'spec',
    roleId: 'worker',
    status,
    dependsOn: [],
  };
  store.tasks.insert(task);
  return task;
}

function seedDispatch(id = 'dispatch_1', settled = false): Dispatch {
  const dispatch: Dispatch = {
    id,
    taskId: 'task_1',
    workerSessionId: WORKER,
    worktreeId: 'wt_1',
    branch: 'fynvra/add-toggle',
    startedAt: 1,
    ...(settled ? { settledAt: 2, outcome: 'succeeded' as const, summary: 'first' } : {}),
  };
  store.dispatches.insert(dispatch);
  return dispatch;
}

const host = (dispatchId = 'dispatch_1') =>
  createWorkerHost({ store, inbox, runId: 'run_1', dispatchId, now: () => 1000 });

const toCoordinator = () => inbox.peek({ to: COORDINATOR });

beforeEach(() => {
  store = new InMemoryOrchestrationStore();
  inbox = new Inbox({ messages: store.messages, now: () => 500 });
  store.runs.insert({
    id: 'run_1',
    workspaceId: 'ws_1',
    coordinatorSessionId: COORDINATOR,
    objective: 'demo',
    createdAt: 0,
  });
});

describe('createWorkerHost · reportDone', () => {
  it('succeeded：结算 dispatch、task → in-review，再给 coordinator 投 worker_done', async () => {
    seedTask();
    seedDispatch();
    const result = await host().reportDone('succeeded', '  Added the toggle.  ', [
      'src/a.ts',
      ' src/a.ts ',
      '',
      'src/b.ts',
    ]);
    expect(result).toEqual({ ok: true });
    expect(store.dispatches.get('dispatch_1')).toMatchObject({
      settledAt: 1000,
      outcome: 'succeeded',
      summary: 'Added the toggle.',
      filesModified: ['src/a.ts', 'src/b.ts'],
    });
    expect(store.tasks.get('task_1')?.status).toBe('in-review');
    const [done] = toCoordinator();
    expect(done).toMatchObject({
      runId: 'run_1',
      dispatchId: 'dispatch_1',
      from: WORKER,
      to: COORDINATOR,
      type: 'worker_done',
      subject: 'succeeded',
      body: 'Added the toggle.\n\nFiles modified (2):\n- src/a.ts\n- src/b.ts',
    });
  });

  it('failed：task → failed', async () => {
    seedTask();
    seedDispatch();
    expect(await host().reportDone('failed', 'Could not reproduce.')).toEqual({ ok: true });
    expect(store.tasks.get('task_1')?.status).toBe('failed');
    expect(store.dispatches.get('dispatch_1')?.outcome).toBe('failed');
    expect(toCoordinator()[0]).toMatchObject({ subject: 'failed', body: 'Could not reproduce.' });
  });

  it('rejects an already settled attempt without rewriting or forwarding the report', async () => {
    seedTask('in-review');
    const before = seedDispatch('dispatch_1', true);
    expect(await host().reportDone('succeeded', 'Also updated the docs.')).toMatchObject({
      ok: false,
    });
    expect(store.dispatches.get('dispatch_1')).toEqual(before);
    expect(store.tasks.get('task_1')?.status).toBe('in-review');
    expect(toCoordinator()).toEqual([]);
  });

  it('旧尝试已被新尝试取代时报错', async () => {
    seedTask();
    seedDispatch('dispatch_1', true);
    seedDispatch('dispatch_2');
    const result = await host('dispatch_1').reportDone('succeeded', 'late');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('dispatch_2') });
    expect(toCoordinator()).toEqual([]);
  });

  it('only one concurrent report settles an attempt, even through different host instances', async () => {
    seedTask();
    seedDispatch();
    const results = await Promise.all([
      host().reportDone('succeeded', 'first'),
      host().reportDone('failed', 'second'),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(store.dispatches.get('dispatch_1')?.summary).toBe('first');
    expect(toCoordinator()).toHaveLength(1);
  });

  it('rejects an old attempt even after the retry is settled', async () => {
    seedTask('in-review');
    const old = seedDispatch('dispatch_1', true);
    const current = seedDispatch('dispatch_2', true);
    expect(await host(old.id).reportDone('failed', 'late')).toMatchObject({ ok: false });
    expect(store.dispatches.get(current.id)).toEqual(current);
    expect(toCoordinator()).toEqual([]);
  });

  it('task 已不在进行中（如已被放弃）时报错，dispatch 保持未结算', async () => {
    seedTask('abandoned');
    seedDispatch();
    const result = await host().reportDone('succeeded', 'done');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('abandoned') });
    expect(store.dispatches.get('dispatch_1')?.settledAt).toBeUndefined();
  });

  it('未知 dispatch、run 不匹配都返回错误而不是抛异常', async () => {
    seedTask();
    seedDispatch();
    expect(await host('dispatch_x').reportDone('succeeded', 'x')).toMatchObject({ ok: false });
    const wrongRun = createWorkerHost({ store, inbox, runId: 'run_x', dispatchId: 'dispatch_1' });
    expect(await wrongRun.reportDone('succeeded', 'x')).toMatchObject({ ok: false });
    expect(store.tasks.get('task_1')?.status).toBe('in-progress');
  });
});

describe('createWorkerHost · askCoordinator', () => {
  beforeEach(() => {
    seedTask();
    seedDispatch();
  });

  it('rejects a superseded attempt before posting or blocking on a new question', async () => {
    const old = host();
    await old.reportDone('succeeded', 'First attempt');
    seedDispatch('dispatch_2');
    store.tasks.update('task_1', { status: 'in-progress' });
    expect(await old.askCoordinator('Late old-round question', 60_000)).toMatchObject({
      ok: false,
      error: expect.stringContaining('dispatch_2'),
    });
    expect(toCoordinator().filter((message) => message.type === 'question')).toEqual([]);
    expect(pendingQuestionOf(inbox, WORKER)).toBeUndefined();
    expect(store.dispatches.get('dispatch_2')?.outcome).toBeUndefined();
  });

  it('投 question，阻塞到 replyTo 指向它的 reply；答复被确认，挂起表清空', async () => {
    const asking = host().askCoordinator('  Which API?  ', 5_000);
    const [question] = toCoordinator();
    expect(question).toMatchObject({
      type: 'question',
      from: WORKER,
      to: COORDINATOR,
      dispatchId: 'dispatch_1',
      body: 'Which API?',
    });
    expect(pendingQuestionOf(inbox, WORKER)).toBe(question?.id);
    expect(pendingQuestionOf(inbox, 'session_other')).toBeUndefined();

    // 别的 reply 不会唤醒它
    inbox.post({
      runId: 'run_1',
      from: COORDINATOR,
      to: WORKER,
      type: 'reply',
      body: 'x',
      replyTo: 'msg_other',
    });
    const reply = inbox.post({
      runId: 'run_1',
      from: COORDINATOR,
      to: WORKER,
      type: 'reply',
      body: 'Use v2.',
      replyTo: question?.id,
    });
    expect(await asking).toEqual({ ok: true, answer: 'Use v2.' });
    expect(reply.ok && store.messages.get(reply.message.id)?.ackedAt).toBe(500);
    expect(pendingQuestionOf(inbox, WORKER)).toBeUndefined();
  });

  it('超时返回 answer: null；问题仍留在 coordinator 收件箱里', async () => {
    expect(await host().askCoordinator('Anyone?', 20)).toEqual({ ok: true, answer: null });
    expect(pendingQuestionOf(inbox, WORKER)).toBeUndefined();
    expect(toCoordinator()).toHaveLength(1);
  });

  it('signal 中止时尽快返回错误', async () => {
    const controller = new AbortController();
    const asking = host().askCoordinator('Anyone?', 60_000, controller.signal);
    controller.abort();
    expect(await asking).toEqual({ ok: false, error: 'ask_coordinator was aborted' });
    expect(pendingQuestionOf(inbox, WORKER)).toBeUndefined();
  });

  it('空问题、未知 dispatch 返回错误', async () => {
    expect(await host().askCoordinator('   ', 10)).toMatchObject({ ok: false });
    expect(await host('dispatch_x').askCoordinator('Q?', 10)).toMatchObject({ ok: false });
    expect(toCoordinator()).toEqual([]);
  });

  it('takePendingQuestion 摘掉挂起的问题', async () => {
    const asking = host().askCoordinator('Q?', 30);
    const questionId = pendingQuestionOf(inbox, WORKER);
    expect(questionId).toBeDefined();
    takePendingQuestion(inbox, questionId as string);
    expect(pendingQuestionOf(inbox, WORKER)).toBeUndefined();
    await asking;
  });
});
