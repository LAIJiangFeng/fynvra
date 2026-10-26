import type { Dispatch, Message, Task } from '@fynvra/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ORCHESTRATION_TOOL_METHODS,
  type OrchestrationHost,
  type OrchestrationToolName,
} from '../host';
import { runTool, toolByName } from '../test-utils/pipeline';
import {
  CHECK_OUTPUT_MAX_CHARS,
  createOrchestrationTools,
  DIFF_MAX_CHARS,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  WAIT_TIMEOUT_MIN_MS,
  WORKER_OUTPUT_PAGE_CHARS,
} from './orchestrationTools';

const task: Task = {
  id: 't1',
  runId: 'r1',
  title: 'Add login',
  spec: 'spec',
  roleId: 'worker',
  status: 'in-progress',
  dependsOn: [],
};
const dispatch: Dispatch = {
  id: 'd1',
  taskId: 't1',
  workerSessionId: 's1',
  worktreeId: 'w1',
  branch: 'fynvra/add-login',
  startedAt: 1,
};

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    runId: 'r1',
    dispatchId: 'd1',
    from: 'worker:s1',
    to: 'coordinator',
    type: 'worker_done',
    body: 'done',
    createdAt: 1,
    ...overrides,
  };
}

function createHost() {
  return {
    dispatchTask: vi.fn<OrchestrationHost['dispatchTask']>(async () => ({
      ok: true,
      task,
      dispatch,
    })),
    listWorkers: vi.fn<OrchestrationHost['listWorkers']>(async () => ({
      ok: true,
      workers: [{ task, dispatch }],
    })),
    waitForWorkers: vi.fn<OrchestrationHost['waitForWorkers']>(async () => ({
      ok: true,
      timedOut: false,
      messages: [],
      pending: 0,
    })),
    readWorkerOutput: vi.fn<OrchestrationHost['readWorkerOutput']>(async () => ({
      ok: true,
      text: 'hello',
      total: 5,
      done: true,
    })),
    sendToWorker: vi.fn<OrchestrationHost['sendToWorker']>(async () => ({
      ok: true,
      messageId: 'm1',
      type: 'instruction',
    })),
    reviewDiff: vi.fn<OrchestrationHost['reviewDiff']>(async () => ({
      ok: true,
      branch: 'fynvra/add-login',
      baseCommit: 'abc1234def567',
      files: ['src/a.ts'],
      stat: ' src/a.ts | 1 +',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;',
    })),
    runChecks: vi.fn<OrchestrationHost['runChecks']>(async () => ({
      ok: true,
      exitCode: 0,
      output: 'all green',
      durationMs: 1200,
    })),
    mergeWorktree: vi.fn<OrchestrationHost['mergeWorktree']>(async () => ({
      ok: true,
      merged: true,
      targetBranch: 'main',
      commit: 'fff0001',
    })),
    rejectWork: vi.fn<OrchestrationHost['rejectWork']>(async () => ({
      ok: true,
      messageId: 'm2',
    })),
    cleanupWorktree: vi.fn<OrchestrationHost['cleanupWorktree']>(async () => ({
      ok: true,
      removedWorktree: true,
      deletedBranch: true,
    })),
  } satisfies OrchestrationHost;
}

const roles = [
  { id: 'worker', name: 'Worker' },
  { id: 'test-engineer', name: '测试工程师', description: 'writes and runs tests' },
];

describe('createOrchestrationTools', () => {
  it('exposes exactly one tool per OrchestrationHost method', () => {
    const tools = createOrchestrationTools(createHost());
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(ORCHESTRATION_TOOL_METHODS));
    expect(new Set(Object.values(ORCHESTRATION_TOOL_METHODS))).toEqual(
      new Set(Object.keys(createHost()))
    );
    expectTypeOf<(typeof ORCHESTRATION_TOOL_METHODS)[OrchestrationToolName]>().toEqualTypeOf<
      keyof OrchestrationHost
    >();
  });

  it('declares a complete, described parameter schema for every tool', () => {
    for (const tool of createOrchestrationTools(createHost(), { roles })) {
      expect(tool.label, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.promptSnippet, tool.name).toBeTruthy();
      // pi 渲染为 "- <name>: <snippet>"，snippet 自己不能再带工具名
      expect(tool.promptSnippet?.startsWith(tool.name), tool.name).toBe(false);
      const schema = tool.parameters as {
        type: string;
        properties: Record<string, { description?: string }>;
        additionalProperties?: boolean;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      for (const [key, property] of Object.entries(schema.properties)) {
        expect(property.description, `${tool.name}.${key}`).toBeTruthy();
      }
    }
  });

  it('lists the available roles as an enum when roles are provided', () => {
    const tool = toolByName(createOrchestrationTools(createHost(), { roles }), 'dispatch_task');
    const role = (tool.parameters as { properties: { role: { enum?: string[] } } }).properties.role;
    expect(role.enum).toEqual(['worker', 'test-engineer']);
  });
});

describe('dispatch_task', () => {
  it('defaults role to worker, trims text and normalizes depends_on', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    const run = await runTool(tool, {
      title: '  Add   login\n form ',
      spec: '  Implement the form.  ',
      depends_on: 't0, t1,t0',
    });
    expect(run.isError).toBe(false);
    expect(host.dispatchTask.mock.calls[0]?.[0]).toEqual({
      title: 'Add login form',
      spec: 'Implement the form.',
      roleId: 'worker',
      dependsOn: ['t0', 't1'],
    });
    expect(run.text).toMatch(/^## Task dispatched/);
    expect(run.text).toContain('d1');
    expect(run.text).toContain('fynvra/add-login');
  });

  it('maps role display names and camelCase aliases to role ids', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host, { roles }), 'dispatch_task');
    const run = await runTool(tool, {
      title: 'Tests',
      spec: 'Write tests',
      roleId: ' 测试工程师 ',
      dependsOn: 't9',
    });
    expect(run.isError).toBe(false);
    expect(host.dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      roleId: 'test-engineer',
      dependsOn: ['t9'],
    });
  });

  it('passes model and thinking through, normalizing aliases and case', async () => {
    const host = createHost();
    host.dispatchTask.mockImplementation(async (input) => ({
      ok: true,
      task: {
        ...task,
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
      },
      dispatch,
    }));
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    const run = await runTool(tool, {
      title: 'x',
      spec: 'y',
      model: ' gpt-6-astra ',
      thinking: ' MAX ',
    });
    expect(run.isError).toBe(false);
    expect(host.dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-6-astra',
      thinking: 'max',
    });
    expect(run.text).toContain('- model: gpt-6-astra · thinking: max');
    host.listWorkers.mockResolvedValueOnce({
      ok: true,
      workers: [{ task: { ...task, thinking: 'high' }, dispatch }],
    });
    const listed = await runTool(toolByName(createOrchestrationTools(host), 'list_workers'), {});
    expect(listed.text).toContain('- model: default \u00b7 thinking: high');

    await runTool(tool, {
      title: 'x',
      spec: 'y',
      model_id: 'openai/gpt-5.5',
      reasoning_effort: 'none',
    });
    expect(host.dispatchTask.mock.calls[1]?.[0]).toMatchObject({
      model: 'openai/gpt-5.5',
      thinking: 'off',
    });
    await runTool(tool, { title: 'x', spec: 'y', modelId: 'm', thinkingLevel: 'high' });
    expect(host.dispatchTask.mock.calls[2]?.[0]).toMatchObject({ model: 'm', thinking: 'high' });
    await runTool(tool, { title: 'x', spec: 'y', thinking_level: 'low', model: '' });
    const fourth = host.dispatchTask.mock.calls[3]?.[0];
    expect(fourth).toMatchObject({ thinking: 'low' });
    expect(fourth).not.toHaveProperty('model');
  });

  it('omits model and thinking when not given and rejects unknown thinking levels', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    await runTool(tool, { title: 'x', spec: 'y' });
    const input = host.dispatchTask.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('model');
    expect(input).not.toHaveProperty('thinking');

    const bad = await runTool(tool, { title: 'x', spec: 'y', thinking: 'ultra' });
    expect(bad.isError).toBe(true);
    expect(host.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown roles before reaching the host', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host, { roles }), 'dispatch_task');
    const run = await runTool(tool, { title: 'x', spec: 'y', role: 'designer' });
    expect(run.isError).toBe(true);
    expect(host.dispatchTask).not.toHaveBeenCalled();
  });

  it('requires a non-empty title and spec', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    const blankTitle = await runTool(tool, { title: '   ', spec: 'y' });
    expect(blankTitle).toMatchObject({ isError: true, stage: 'execute' });
    expect(blankTitle.text).toContain('title is required');
    const missingSpec = await runTool(tool, { title: 'x' });
    expect(missingSpec.isError).toBe(true);
    expect(host.dispatchTask).not.toHaveBeenCalled();
  });

  it('reports a queued task when dependencies are not done yet', async () => {
    const host = createHost();
    host.dispatchTask.mockResolvedValueOnce({
      ok: true,
      task: { ...task, id: 't2', status: 'todo', dependsOn: ['t1'] },
    });
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    const run = await runTool(tool, { title: 'Second', spec: 'after t1', depends_on: ['t1'] });
    expect(run.text).toMatch(/^## Task queued/);
    expect(run.text).toContain('t1');
  });

  it('turns host failures and host exceptions into error text', async () => {
    const host = createHost();
    host.dispatchTask.mockResolvedValueOnce({ ok: false, error: 'git worktree add failed' });
    host.dispatchTask.mockRejectedValueOnce(new Error('IPC channel closed'));
    const tool = toolByName(createOrchestrationTools(host), 'dispatch_task');
    const failed = await runTool(tool, { title: 'x', spec: 'y' });
    expect(failed).toMatchObject({ isError: true, stage: 'execute' });
    expect(failed.text).toContain('git worktree add failed');
    const thrown = await runTool(tool, { title: 'x', spec: 'y' });
    expect(thrown.isError).toBe(true);
    expect(thrown.text).toContain('IPC channel closed');
  });
});

describe('wait_for_workers', () => {
  async function waitArgs(args: unknown) {
    const host = createHost();
    const run = await runTool(toolByName(createOrchestrationTools(host), 'wait_for_workers'), args);
    return { run, input: host.waitForWorkers.mock.calls[0]?.[0] };
  }

  it('defaults until to all and timeout to the default', async () => {
    expect((await waitArgs({})).input).toEqual({
      timeoutMs: WAIT_TIMEOUT_DEFAULT_MS,
      until: 'all',
    });
  });

  it('clamps timeout_ms into the allowed range before validation', async () => {
    expect((await waitArgs({ timeout_ms: 5 })).input).toMatchObject({
      timeoutMs: WAIT_TIMEOUT_MIN_MS,
    });
    expect((await waitArgs({ timeout_ms: 10_000_000 })).input).toMatchObject({
      timeoutMs: WAIT_TIMEOUT_MAX_MS,
    });
    expect((await waitArgs({ timeoutMs: '60000', until: ' ANY ' })).input).toEqual({
      timeoutMs: 60_000,
      until: 'any',
    });
    expect((await waitArgs({ timeout_ms: 1234.6 })).input).toMatchObject({ timeoutMs: 1235 });
  });

  it('rejects an unknown until value without calling the host', async () => {
    const { run, input } = await waitArgs({ until: 'some' });
    expect(run).toMatchObject({ isError: true, stage: 'validate' });
    expect(input).toBeUndefined();
  });

  it('tells the coordinator how to handle each incoming message', async () => {
    const host = createHost();
    host.waitForWorkers.mockResolvedValueOnce({
      ok: true,
      timedOut: false,
      pending: 1,
      messages: [
        message({ id: 'm7', type: 'question', dispatchId: 'd2', body: 'Use REST or GraphQL?' }),
        message({ type: 'worker_done', body: 'succeeded: added form' }),
      ],
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'wait_for_workers'), {});
    expect(run.text).toContain('Use REST or GraphQL?');
    expect(run.text).toContain('send_to_worker');
    expect(run.text).toContain('d2');
    expect(run.text).toContain('review_diff');
  });

  it('explains that a timeout is not a failure', async () => {
    const host = createHost();
    host.waitForWorkers.mockResolvedValueOnce({
      ok: true,
      timedOut: true,
      pending: 2,
      messages: [],
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'wait_for_workers'), {});
    expect(run.isError).toBe(false);
    expect(run.text).toContain('timed out');
    expect(run.text).toContain('not a failure');
  });
});

describe('read_worker_output', () => {
  it('pages long output and points at the next cursor', async () => {
    const host = createHost();
    const long = `${'x'.repeat(WORKER_OUTPUT_PAGE_CHARS)}REST`;
    host.readWorkerOutput.mockResolvedValueOnce({
      ok: true,
      text: long,
      total: long.length,
      done: false,
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'read_worker_output'), {
      dispatch_id: 'd1',
    });
    expect(host.readWorkerOutput.mock.calls[0]?.[0]).toEqual({ dispatchId: 'd1', cursor: 0 });
    expect(run.text).not.toContain('REST');
    expect(run.text).toContain(`cursor ${WORKER_OUTPUT_PAGE_CHARS}`);
  });

  it('accepts numeric string cursors and clamps negative ones to 0', async () => {
    const host = createHost();
    const tool = toolByName(createOrchestrationTools(host), 'read_worker_output');
    await runTool(tool, { dispatchId: 'd1', cursor: '40' });
    await runTool(tool, { dispatch_id: 'd1', cursor: -5 });
    expect(host.readWorkerOutput.mock.calls.map((call) => call[0])).toEqual([
      { dispatchId: 'd1', cursor: 40 },
      { dispatchId: 'd1', cursor: 0 },
    ]);
  });

  it('requires dispatch_id', async () => {
    const host = createHost();
    const run = await runTool(toolByName(createOrchestrationTools(host), 'read_worker_output'), {});
    expect(run.isError).toBe(true);
    expect(host.readWorkerOutput).not.toHaveBeenCalled();
  });
});

describe('review, checks, merge and follow-up tools', () => {
  it('truncates long diffs and points at git_readonly for single files', async () => {
    const host = createHost();
    host.reviewDiff.mockResolvedValueOnce({
      ok: true,
      branch: 'fynvra/add-login',
      baseCommit: 'abc1234def567',
      files: ['src/a.ts'],
      stat: ' src/a.ts | 9999 +',
      diff: `${'+'.repeat(DIFF_MAX_CHARS)}TAIL_OF_DIFF`,
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'review_diff'), {
      dispatch_id: 'd1',
    });
    expect(run.text).not.toContain('TAIL_OF_DIFF');
    expect(run.text).toContain('git_readonly');
  });

  it('flags an empty diff as possibly uncommitted work', async () => {
    const host = createHost();
    host.reviewDiff.mockResolvedValueOnce({
      ok: true,
      branch: 'fynvra/add-login',
      baseCommit: 'abc1234',
      files: [],
      stat: '',
      diff: '',
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'review_diff'), {
      dispatch_id: 'd1',
    });
    expect(run.text).toContain('No changes');
    expect(run.text).toContain('commit');
  });

  it('reports failing checks with the tail of the output', async () => {
    const host = createHost();
    host.runChecks.mockResolvedValueOnce({
      ok: true,
      exitCode: 2,
      output: `HEAD_OF_LOG${'.'.repeat(CHECK_OUTPUT_MAX_CHARS)}error TS2322 at src/a.ts`,
      durationMs: 4200,
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'run_checks'), {
      dispatch_id: 'd1',
      command: '  pnpm typecheck  ',
    });
    expect(host.runChecks.mock.calls[0]?.[0]).toEqual({
      dispatchId: 'd1',
      command: 'pnpm typecheck',
    });
    expect(run.isError).toBe(false);
    expect(run.text).toContain('FAILED (exit code 2)');
    expect(run.text).toContain('error TS2322 at src/a.ts');
    expect(run.text).not.toContain('HEAD_OF_LOG');
  });

  it('lists conflicting files when the merge is aborted', async () => {
    const host = createHost();
    host.mergeWorktree.mockResolvedValueOnce({
      ok: true,
      merged: false,
      targetBranch: 'main',
      conflicts: ['src/a.ts', 'src/b.ts'],
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'merge_worktree'), {
      dispatch_id: 'd1',
    });
    expect(run.text).toContain('aborted');
    expect(run.text).toContain('src/a.ts');
    expect(run.text).toContain('reject_work');
  });

  it('requires text for send_to_worker and reject_work', async () => {
    const host = createHost();
    const tools = createOrchestrationTools(host);
    const send = await runTool(toolByName(tools, 'send_to_worker'), {
      dispatch_id: 'd1',
      body: ' ',
    });
    const reject = await runTool(toolByName(tools, 'reject_work'), { dispatch_id: 'd1' });
    expect(send.isError).toBe(true);
    expect(reject.isError).toBe(true);
    expect(host.sendToWorker).not.toHaveBeenCalled();
    expect(host.rejectWork).not.toHaveBeenCalled();
    const ok = await runTool(toolByName(tools, 'reject_work'), {
      dispatch_id: 'd1',
      feedback: '  tests fail  ',
    });
    expect(ok.isError).toBe(false);
    expect(host.rejectWork.mock.calls[0]?.[0]).toEqual({
      dispatchId: 'd1',
      feedback: 'tests fail',
    });
  });

  it('describes an empty worker list', async () => {
    const host = createHost();
    host.listWorkers.mockResolvedValueOnce({ ok: true, workers: [] });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'list_workers'), {});
    expect(run.text).toContain('## Workers (0)');
  });
});

describe('workspace without git (in-place dispatches)', () => {
  const inPlace: Dispatch = { ...dispatch, worktreeId: '', branch: '', mode: 'in-place' };

  it('dispatch_task: no branch, the shared directory, and one task at a time', async () => {
    const host = createHost();
    host.dispatchTask.mockResolvedValueOnce({ ok: true, task, dispatch: inPlace });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'dispatch_task'), {
      title: 'Add login',
      spec: 'S',
    });
    expect(run.text).toMatch(/^## Task dispatched/);
    expect(run.text).toContain('works in: the workspace directory itself');
    expect(run.text).toMatch(/dispatch one task at a time/i);
    expect(run.text).not.toContain('branch:');
    expect(run.text).not.toContain('own worktree');
  });

  it('list_workers: in place instead of a branch', async () => {
    const host = createHost();
    host.listWorkers.mockResolvedValueOnce({ ok: true, workers: [{ task, dispatch: inPlace }] });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'list_workers'), {});
    expect(run.text).toContain('`d1` · in place (no git)');
    expect(run.text).not.toContain('branch:');
  });

  it('review_diff: no diff, the files the worker reported instead', async () => {
    const host = createHost();
    const files = ['hello.txt', 'src/a.ts'];
    host.reviewDiff.mockResolvedValueOnce({
      ok: true,
      branch: '',
      baseCommit: '',
      files,
      stat: '',
      diff: '',
      mode: 'in-place',
    });
    host.reviewDiff.mockResolvedValueOnce({
      ok: true,
      branch: '',
      baseCommit: '',
      files: [],
      stat: '',
      diff: '',
      mode: 'in-place',
    });
    const tool = toolByName(createOrchestrationTools(host), 'review_diff');
    const listed = await runTool(tool, { dispatch_id: 'd1' });
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('there is no diff');
    expect(listed.text).toContain('files reported by the worker (2): `hello.txt`, `src/a.ts`');
    expect(listed.text).toContain('run_checks');
    expect(listed.text).not.toContain('### Diff');
    const empty = await runTool(tool, { dispatch_id: 'd1' });
    expect(empty.text).toContain('files reported by the worker: none');
    expect(empty.text).toContain('reject_work');
  });

  it('merge_worktree: nothing to merge, the task is completed', async () => {
    const host = createHost();
    host.mergeWorktree.mockResolvedValueOnce({
      ok: true,
      merged: true,
      targetBranch: '',
      mode: 'in-place',
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'merge_worktree'), {
      dispatch_id: 'd1',
    });
    expect(run.text).toMatch(/^## Accepted \(no git\)/);
    expect(run.text).toContain('nothing to merge');
    expect(run.text).toContain('the task is completed');
    expect(run.text).toContain('cleanup_worktree');
  });

  it('cleanup_worktree: nothing to clean up, the changes stay', async () => {
    const host = createHost();
    host.cleanupWorktree.mockResolvedValueOnce({
      ok: true,
      removedWorktree: false,
      deletedBranch: false,
      mode: 'in-place',
    });
    const run = await runTool(toolByName(createOrchestrationTools(host), 'cleanup_worktree'), {
      dispatch_id: 'd1',
    });
    expect(run.text).toContain('nothing to clean up');
    expect(run.text).toContain('stay in the workspace directory');
    expect(run.text).not.toContain('worktree removed');
  });

  it('the tool descriptions say what changes without git', () => {
    const tools = createOrchestrationTools(createHost());
    for (const name of [
      'dispatch_task',
      'review_diff',
      'run_checks',
      'merge_worktree',
      'cleanup_worktree',
    ] as const) {
      expect(toolByName(tools, name).description, name).toMatch(/without git|no git/i);
    }
  });
});

describe('execute never throws', () => {
  it('returns error text for garbage params and a throwing host', async () => {
    const throwing = Object.fromEntries(
      Object.keys(createHost()).map((method) => [
        method,
        () => {
          throw new Error(`boom from ${method}`);
        },
      ])
    ) as unknown as OrchestrationHost;
    for (const tool of createOrchestrationTools(throwing, { roles })) {
      for (const params of [null, 42, 'x', [], { dispatch_id: 7, title: {}, spec: [] }]) {
        const result = await tool.execute(
          'call',
          params as never,
          undefined,
          undefined,
          {} as never
        );
        expect(result.isError, `${tool.name} ${JSON.stringify(params)}`).toBe(true);
        expect(result.content[0]).toMatchObject({ type: 'text' });
      }
    }
  });
});
