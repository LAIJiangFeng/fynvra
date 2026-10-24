import type { ApprovalMode } from '@fynvra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TIMEOUT_DEFAULT_MS,
  type ApprovalGateRequest,
  type ApprovalRequestFn,
  createApprovalGate,
  type GatedToolCall,
} from './gate';
import type { ApprovalDecision } from './policy';

/** 四类工具各一个代表调用 */
const CALLS = {
  command: { toolCallId: 'c-bash', toolName: 'bash', input: { command: 'echo hi' } },
  'file-write': {
    toolCallId: 'c-write',
    toolName: 'write',
    input: { path: 'a.txt', content: 'x' },
  },
  'file-edit': {
    toolCallId: 'c-edit',
    toolName: 'edit',
    input: { path: 'a.txt', edits: [{ oldText: 'x', newText: 'y' }] },
  },
  mcp: { toolCallId: 'c-mcp', toolName: 'mcp__docs__search', input: { query: 'pi' } },
} satisfies Record<string, GatedToolCall>;

function setup(mode: ApprovalMode, answer: ApprovalDecision | ApprovalRequestFn = 'allow') {
  const requests: ApprovalGateRequest[] = [];
  const signals: AbortSignal[] = [];
  const request = vi.fn<ApprovalRequestFn>(async (req, signal) => {
    requests.push(req);
    signals.push(signal);
    return typeof answer === 'function' ? answer(req, signal) : answer;
  });
  const gate = createApprovalGate({ mode, request, now: () => 5_000 });
  return { gate, request, requests, signals };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createApprovalGate modes', () => {
  const table: Record<ApprovalMode, (keyof typeof CALLS)[]> = {
    supervised: ['command', 'file-write', 'file-edit', 'mcp'],
    'auto-edits': ['command', 'mcp'],
    full: [],
  };

  for (const [mode, gated] of Object.entries(table) as [ApprovalMode, (keyof typeof CALLS)[]][]) {
    it.each(Object.keys(CALLS) as (keyof typeof CALLS)[])(`${mode} × %s`, async (kind) => {
      const env = setup(mode);
      await expect(env.gate.check(CALLS[kind])).resolves.toBeUndefined();
      expect(env.request).toHaveBeenCalledTimes(gated.includes(kind) ? 1 : 0);
    });
  }

  it('never asks about read-only or coordination tools', async () => {
    const env = setup('supervised');
    for (const toolName of ['read', 'grep', 'ls', 'git_readonly', 'report_done', 'dispatch_task']) {
      await expect(
        env.gate.check({ toolCallId: toolName, toolName, input: { path: '.' } })
      ).resolves.toBeUndefined();
    }
    expect(env.request).not.toHaveBeenCalled();
  });

  it('hands the host a described request that expires after the timeout', async () => {
    const env = setup('supervised');
    await env.gate.check(CALLS.command);
    await env.gate.check(CALLS['file-write']);
    expect(env.requests).toEqual([
      {
        toolCallId: 'c-bash',
        toolName: 'bash',
        kind: 'command',
        title: 'bash',
        detail: 'echo hi',
        args: { command: 'echo hi' },
        expiresAt: 5_000 + APPROVAL_TIMEOUT_DEFAULT_MS,
      },
      {
        toolCallId: 'c-write',
        toolName: 'write',
        kind: 'file-write',
        title: 'write',
        detail: 'a.txt',
        args: { path: 'a.txt', content: 'x' },
        expiresAt: 5_000 + APPROVAL_TIMEOUT_DEFAULT_MS,
      },
    ]);
  });
});

describe('createApprovalGate protected floor', () => {
  it('asks about a protected command even in full mode', async () => {
    const env = setup('full');
    await expect(
      env.gate.check({ toolCallId: 'c1', toolName: 'bash', input: { command: 'git push' } })
    ).resolves.toBeUndefined();
    expect(env.requests[0]).toMatchObject({ kind: 'command', protectedAction: 'git push' });
  });

  it('applies the floor to run_checks and powershell as command tools', async () => {
    const env = setup('full');
    await env.gate.check({
      toolCallId: 'c1',
      toolName: 'run_checks',
      input: { dispatch_id: 'dsp_1', command: 'pnpm test && npm publish' },
    });
    await env.gate.check({
      toolCallId: 'c2',
      toolName: 'powershell',
      input: { command: 'Remove-Item -Recurse -Force dist' },
    });
    await env.gate.check({
      toolCallId: 'c3',
      toolName: 'run_checks',
      input: { dispatch_id: 'dsp_1', command: 'pnpm test' },
    });
    expect(env.requests.map((request) => request.protectedAction)).toEqual([
      'npm publish',
      'Remove-Item -Recurse',
    ]);
  });

  it('is not bypassed by allowSession', async () => {
    const env = setup('auto-edits', 'allowSession');
    await env.gate.check(CALLS.command);
    await env.gate.check({ toolCallId: 'c2', toolName: 'bash', input: { command: 'ls' } });
    await env.gate.check({
      toolCallId: 'c3',
      toolName: 'bash',
      input: { command: 'git reset --hard HEAD~1' },
    });
    expect(env.requests.map((request) => request.toolCallId)).toEqual(['c-bash', 'c3']);
  });

  it('names the protected action in the refusal text', async () => {
    const env = setup('full', 'deny');
    const verdict = await env.gate.check({
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'rm -rf build' },
    });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('rm -rf build');
    expect(verdict?.reason).toContain('protected action (rm -rf)');
  });
});

describe('createApprovalGate decisions', () => {
  it('allow lets one call through and asks again next time', async () => {
    const env = setup('supervised', 'allow');
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.request).toHaveBeenCalledTimes(2);
  });

  it('allowSession lets later calls of the same kind and tool through', async () => {
    const env = setup('supervised', 'allowSession');
    await env.gate.check(CALLS.command);
    await env.gate.check({ toolCallId: 'c2', toolName: 'bash', input: { command: 'pnpm test' } });
    await env.gate.check(CALLS['file-write']);
    await env.gate.check({ toolCallId: 'c4', toolName: 'write', input: { path: 'b.txt' } });
    // 同类 = kind + 工具名：放行过 bash / write，不等于放行 powershell / edit
    await env.gate.check({ toolCallId: 'c5', toolName: 'powershell', input: { command: 'dir' } });
    await env.gate.check(CALLS['file-edit']);
    expect(env.requests.map((request) => request.toolCallId)).toEqual([
      'c-bash',
      'c-write',
      'c5',
      'c-edit',
    ]);
  });

  it('keeps allowSession per gate: another session asks again', async () => {
    const first = setup('supervised', 'allowSession');
    await first.gate.check(CALLS.command);
    const second = setup('supervised', 'allow');
    await second.gate.check(CALLS.command);
    expect(second.request).toHaveBeenCalledTimes(1);
  });

  it('deny blocks the call with a readable refusal instead of throwing', async () => {
    const env = setup('supervised', 'deny');
    const verdict = await env.gate.check(CALLS.command);
    expect(verdict).toEqual({ block: true, reason: expect.any(String) });
    expect(verdict?.reason).toContain('denied');
    expect(verdict?.reason).toContain('`echo hi`');
    expect(verdict?.reason).toContain('was not run');
    // 拒绝不进 allowSession：下次照常询问
    await env.gate.check(CALLS.command);
    expect(env.request).toHaveBeenCalledTimes(2);
  });

  it('describes the denied file operation by its path', async () => {
    const env = setup('supervised', 'deny');
    expect((await env.gate.check(CALLS['file-write']))?.reason).toContain('writing a.txt');
    expect((await env.gate.check(CALLS['file-edit']))?.reason).toContain('editing a.txt');
    expect((await env.gate.check(CALLS.mcp))?.reason).toContain('mcp__docs__search');
  });
});

describe('createApprovalGate fail-closed', () => {
  it('denies when nobody answers before the timeout and withdraws the request', async () => {
    vi.useFakeTimers();
    const env = setup('supervised', () => new Promise<ApprovalDecision>(() => {}));
    const verdict = env.gate.check(CALLS.command);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_DEFAULT_MS - 1);
    expect(env.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await verdict;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('10 minutes');
    expect(result?.reason).toContain('was not run');
    expect(env.signals[0]?.aborted).toBe(true);
  });

  it('honours a custom timeout', async () => {
    vi.useFakeTimers();
    const request = vi.fn<ApprovalRequestFn>(() => new Promise(() => {}));
    const gate = createApprovalGate({ mode: 'supervised', request, timeoutMs: 1_000 });
    const verdict = gate.check(CALLS.command);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await verdict)?.block).toBe(true);
  });

  it('denies when the run is aborted while waiting', async () => {
    const env = setup('supervised', () => new Promise<ApprovalDecision>(() => {}));
    const run = new AbortController();
    const verdict = env.gate.check(CALLS.command, run.signal);
    await vi.waitFor(() => expect(env.request).toHaveBeenCalled());
    run.abort();
    const result = await verdict;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('stopped');
    expect(env.signals[0]?.aborted).toBe(true);
  });

  it('does not ask at all when the run is already aborted', async () => {
    const env = setup('supervised');
    const run = new AbortController();
    run.abort();
    expect((await env.gate.check(CALLS.command, run.signal))?.block).toBe(true);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('denies when the host cannot ask', async () => {
    const env = setup('supervised', async () => {
      throw new Error('no window to ask in');
    });
    const verdict = await env.gate.check(CALLS.command);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('no window to ask in');
  });

  it('denies an answer that is not a known decision', async () => {
    const env = setup('supervised', async () => 'yes' as ApprovalDecision);
    expect((await env.gate.check(CALLS.command))?.block).toBe(true);
  });

  it('denies when the request hook throws synchronously', async () => {
    const gate = createApprovalGate({
      mode: 'supervised',
      request: () => {
        throw new Error('boom');
      },
    });
    expect((await gate.check(CALLS.command))?.reason).toContain('boom');
  });

  it('does not let a late answer change a timed-out verdict', async () => {
    vi.useFakeTimers();
    let answer: (decision: ApprovalDecision) => void = () => {};
    const env = setup(
      'supervised',
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          answer = resolve;
        })
    );
    const verdict = env.gate.check(CALLS.command);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_DEFAULT_MS);
    answer('allowSession');
    expect((await verdict)?.block).toBe(true);
    // 超时后到达的 allowSession 不生效：下一次照常询问
    const next = env.gate.check(CALLS.command);
    expect(env.request).toHaveBeenCalledTimes(2);
    answer('allow');
    await expect(next).resolves.toBeUndefined();
  });
});

describe('createApprovalGate pi extension', () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  function load(gate: ReturnType<typeof createApprovalGate>) {
    const handlers = new Map<string, Handler>();
    const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
    gate.extension.factory(pi as never);
    const toolCall = handlers.get('tool_call');
    if (!toolCall) throw new Error('the gate did not register a tool_call handler');
    return toolCall;
  }

  it('registers a hidden extension that answers pi tool_call events', async () => {
    const env = setup('supervised', 'deny');
    expect(env.gate.extension).toMatchObject({ name: 'fynvra-approval-gate', hidden: true });
    const onToolCall = load(env.gate);
    const run = new AbortController();
    const result = await onToolCall(
      { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
      { signal: run.signal }
    );
    expect(result).toMatchObject({ block: true });
    expect(env.requests[0]).toMatchObject({ toolCallId: 'c1', detail: 'ls' });
    expect(
      await onToolCall(
        { type: 'tool_call', toolCallId: 'c2', toolName: 'read', input: { path: 'a' } },
        { signal: run.signal }
      )
    ).toBeUndefined();
  });

  it('still asks when the pi context has no usable signal', async () => {
    const env = setup('supervised', 'allow');
    const onToolCall = load(env.gate);
    const ctx = {
      get signal(): AbortSignal {
        throw new Error('This extension ctx is stale after session replacement or reload.');
      },
    };
    await expect(
      onToolCall(
        { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: CALLS.command.input },
        ctx
      )
    ).resolves.toBeUndefined();
    expect(env.request).toHaveBeenCalledTimes(1);
  });
});
