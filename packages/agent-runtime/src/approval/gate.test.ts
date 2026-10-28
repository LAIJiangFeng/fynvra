import type { ApprovalMode, ToolOperationNotice } from '@fynvra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TIMEOUT_DEFAULT_MS,
  type ApprovalPolicyHooks,
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
  const notices: ToolOperationNotice[] = [];
  const request = vi.fn<ApprovalRequestFn>(async (req, signal) =>
    typeof answer === 'function' ? answer(req, signal) : answer
  );
  const notify = vi.fn<NonNullable<ApprovalPolicyHooks['notify']>>((notice) => {
    notices.push(notice);
  });
  const gate = createApprovalGate({ mode, request, notify, now: () => 5_000 });
  return { gate, request, notify, notices };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createApprovalGate notification scopes', () => {
  const table: Record<ApprovalMode, (keyof typeof CALLS)[]> = {
    supervised: ['command', 'file-write', 'file-edit', 'mcp'],
    'auto-edits': ['command', 'mcp'],
    full: [],
  };

  for (const [mode, notified] of Object.entries(table) as [
    ApprovalMode,
    (keyof typeof CALLS)[],
  ][]) {
    it.each(Object.keys(CALLS) as (keyof typeof CALLS)[])(`${mode} × %s`, async (kind) => {
      const env = setup(mode);
      await expect(env.gate.check(CALLS[kind])).resolves.toBeUndefined();
      expect(env.notify).toHaveBeenCalledTimes(notified.includes(kind) ? 1 : 0);
      expect(env.request).not.toHaveBeenCalled();
    });
  }

  it('never notifies about read-only or coordination tools', async () => {
    const env = setup('supervised');
    for (const toolName of [
      'read',
      'grep',
      'ls',
      'git_readonly',
      'report_done',
      'dispatch_task',
      'ask_coordinator',
    ]) {
      await expect(
        env.gate.check({ toolCallId: toolName, toolName, input: { path: '.' } })
      ).resolves.toBeUndefined();
    }
    expect(env.request).not.toHaveBeenCalled();
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('sends only fixed labels and ids, without commands, paths, args or expiry', async () => {
    const env = setup('supervised');
    await env.gate.check(CALLS.command);
    await env.gate.check(CALLS['file-write']);
    await env.gate.check(CALLS.mcp);
    expect(env.notices).toEqual([
      { toolCallId: 'c-bash', toolName: 'bash', kind: 'command' },
      { toolCallId: 'c-write', toolName: 'write', kind: 'file-write' },
      { toolCallId: 'c-mcp', toolName: 'mcp', kind: 'mcp' },
    ]);
    expect(env.request).not.toHaveBeenCalled();
  });
});

describe('createApprovalGate important commands', () => {
  it('notifies about an important command even in full mode', async () => {
    const env = setup('full');
    await expect(
      env.gate.check({ toolCallId: 'c1', toolName: 'bash', input: { command: 'git push' } })
    ).resolves.toBeUndefined();
    expect(env.notices).toEqual([{ toolCallId: 'c1', toolName: 'bash', kind: 'command' }]);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('recognizes run_checks and powershell without leaking their commands', async () => {
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
    expect(env.notices).toEqual([
      { toolCallId: 'c1', toolName: 'run_checks', kind: 'command' },
      { toolCallId: 'c2', toolName: 'powershell', kind: 'command' },
    ]);
  });

  it('never uses a legacy allowSession answer to suppress later notices', async () => {
    const env = setup('auto-edits', 'allowSession');
    await env.gate.check(CALLS.command);
    await env.gate.check({ toolCallId: 'c2', toolName: 'bash', input: { command: 'ls' } });
    await env.gate.check({
      toolCallId: 'c3',
      toolName: 'bash',
      input: { command: 'git reset --hard HEAD~1' },
    });
    expect(env.notices.map((notice) => notice.toolCallId)).toEqual(['c-bash', 'c2', 'c3']);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('notifies about recursive removal without asking the old deny hook', async () => {
    const env = setup('full', 'deny');
    await expect(
      env.gate.check({
        toolCallId: 'c1',
        toolName: 'bash',
        input: { command: 'rm -rf build' },
      })
    ).resolves.toBeUndefined();
    expect(env.notices).toEqual([{ toolCallId: 'c1', toolName: 'bash', kind: 'command' }]);
    expect(env.request).not.toHaveBeenCalled();
  });
});

describe('createApprovalGate legacy decisions', () => {
  it('notifies on each call without asking for allow', async () => {
    const env = setup('supervised', 'allow');
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(2);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('does not create kind or tool exemptions from allowSession', async () => {
    const env = setup('supervised', 'allowSession');
    await env.gate.check(CALLS.command);
    await env.gate.check({ toolCallId: 'c2', toolName: 'bash', input: { command: 'pnpm test' } });
    await env.gate.check(CALLS['file-write']);
    await env.gate.check({ toolCallId: 'c4', toolName: 'write', input: { path: 'b.txt' } });
    await env.gate.check({ toolCallId: 'c5', toolName: 'powershell', input: { command: 'dir' } });
    await env.gate.check(CALLS['file-edit']);
    expect(env.notices.map((notice) => notice.toolCallId)).toEqual([
      'c-bash',
      'c2',
      'c-write',
      'c4',
      'c5',
      'c-edit',
    ]);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('keeps notification scope and delivery isolated per session', async () => {
    const first = setup('supervised', 'allowSession');
    const second = setup('supervised', 'allow');
    first.gate.setMode('full');
    await first.gate.check(CALLS.command);
    await second.gate.check(CALLS.command);
    expect(first.notify).not.toHaveBeenCalled();
    expect(second.notify).toHaveBeenCalledTimes(1);
    expect(second.gate.mode).toBe('supervised');
  });

  it('does not consult a legacy deny answer or cache a decision', async () => {
    const env = setup('supervised', 'deny');
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.request).not.toHaveBeenCalled();
    expect(env.notify).toHaveBeenCalledTimes(2);
  });

  it('keeps file contents and MCP names out of operation notices', async () => {
    const env = setup('supervised', 'deny');
    for (const kind of ['file-write', 'file-edit', 'mcp'] as const) {
      await expect(env.gate.check(CALLS[kind])).resolves.toBeUndefined();
    }
    expect(env.notices).toEqual([
      { toolCallId: 'c-write', toolName: 'write', kind: 'file-write' },
      { toolCallId: 'c-edit', toolName: 'edit', kind: 'file-edit' },
      { toolCallId: 'c-mcp', toolName: 'mcp', kind: 'mcp' },
    ]);
    expect(env.request).not.toHaveBeenCalled();
  });
});

describe('createApprovalGate notification failures and Stop', () => {
  it('continues immediately when notification delivery never settles, without a timer', async () => {
    vi.useFakeTimers();
    const env = setup('supervised', () => new Promise<ApprovalDecision>(() => {}));
    env.notify.mockImplementation(() => new Promise<void>(() => {}));
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores the legacy custom approval timeout', async () => {
    vi.useFakeTimers();
    const request = vi.fn<ApprovalRequestFn>(() => new Promise(() => {}));
    const gate = createApprovalGate({ mode: 'supervised', request, timeoutMs: 1_000 });
    await expect(gate.check(CALLS.command)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks when Stop arrives during the synchronous notification hook', async () => {
    const env = setup('supervised');
    const run = new AbortController();
    env.notify.mockImplementation(() => {
      run.abort();
    });
    await expect(env.gate.check(CALLS.command, run.signal)).resolves.toEqual({
      block: true,
      reason: expect.stringContaining('stopped'),
    });
    expect(env.request).not.toHaveBeenCalled();
  });

  it('does not notify or ask when the run is already aborted', async () => {
    const env = setup('supervised');
    const run = new AbortController();
    run.abort();
    expect((await env.gate.check(CALLS.command, run.signal))?.block).toBe(true);
    expect(env.request).not.toHaveBeenCalled();
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('continues when the notification promise rejects', async () => {
    const env = setup('supervised');
    env.notify.mockRejectedValue(new Error('no window to notify'));
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('does not consult unknown legacy decisions', async () => {
    const env = setup('supervised', async () => 'yes' as ApprovalDecision);
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.request).not.toHaveBeenCalled();
    expect(env.notify).toHaveBeenCalledTimes(1);
  });

  it('continues when the notification hook throws synchronously', async () => {
    const env = setup('supervised');
    env.notify.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('a late notification failure cannot change the verdict or block the next call', async () => {
    vi.useFakeTimers();
    const env = setup('supervised');
    let rejectDelivery: (error: Error) => void = () => {};
    env.notify.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelivery = reject;
        })
    );
    const verdict = env.gate.check(CALLS.command);
    await expect(verdict).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_DEFAULT_MS);
    rejectDelivery(new Error('late failure'));
    await expect(verdict).resolves.toBeUndefined();
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createApprovalGate setMode', () => {
  const push = { toolCallId: 'c-push', toolName: 'bash', input: { command: 'git push' } };

  it('applies the new notification scope from the next call on', async () => {
    const env = setup('supervised');
    await env.gate.check(CALLS['file-write']);
    env.gate.setMode('auto-edits');
    expect(env.gate.mode).toBe('auto-edits');
    await env.gate.check(CALLS['file-write']);
    await env.gate.check(CALLS.command);
    env.gate.setMode('full');
    await env.gate.check(CALLS.command);
    await env.gate.check(CALLS.mcp);
    env.gate.setMode('supervised');
    await env.gate.check(CALLS['file-edit']);
    expect(env.notices.map((notice) => notice.toolCallId)).toEqual(['c-write', 'c-bash', 'c-edit']);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('keeps notifying when switching between scopes that include the same tool', async () => {
    const env = setup('supervised', 'allowSession');
    await env.gate.check(CALLS.command);
    env.gate.setMode('auto-edits');
    await env.gate.check(CALLS.command);
    env.gate.setMode('supervised');
    await env.gate.check(CALLS.command);
    expect(env.notify).toHaveBeenCalledTimes(3);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('resumes notices when switching back from full', async () => {
    const env = setup('supervised', 'allowSession');
    await env.gate.check(CALLS.command);
    env.gate.setMode('full');
    await env.gate.check(CALLS.command);
    env.gate.setMode('auto-edits');
    await env.gate.check(CALLS.command);
    expect(env.notices.map((notice) => notice.toolCallId)).toEqual(['c-bash', 'c-bash']);
  });

  it('does not suppress important notices when setting the same mode again', async () => {
    const env = setup('full', 'allowSession');
    await env.gate.check(push);
    env.gate.setMode('full');
    await env.gate.check(push);
    env.gate.setMode('supervised');
    await env.gate.check(CALLS.command);
    expect(env.notices.map((notice) => notice.toolCallId)).toEqual(['c-push', 'c-push', 'c-bash']);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('still notifies about important commands after switching to full', async () => {
    const env = setup('supervised', 'deny');
    env.gate.setMode('full');
    await expect(env.gate.check(push)).resolves.toBeUndefined();
    expect(env.notices).toEqual([{ toolCallId: 'c-push', toolName: 'bash', kind: 'command' }]);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('changing mode does not wait for a pending delivery or replay the original call', async () => {
    const env = setup('supervised');
    let delivered: () => void = () => {};
    env.notify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          delivered = resolve;
        })
    );
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    env.gate.setMode('full');
    delivered();
    await expect(env.gate.check(CALLS.command)).resolves.toBeUndefined();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('hands itself to the host through onGate so the host can switch it later', () => {
    const onGate = vi.fn();
    const gate = createApprovalGate({ mode: 'auto-edits', request: async () => 'allow', onGate });
    expect(onGate).toHaveBeenCalledTimes(1);
    expect(onGate).toHaveBeenCalledWith(gate);
    expect(gate.mode).toBe('auto-edits');
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

  it('registers a hidden extension that notifies and respects pi tool_call cancellation', async () => {
    const env = setup('supervised', 'deny');
    expect(env.gate.extension).toMatchObject({ name: 'fynvra-tool-notices', hidden: true });
    const onToolCall = load(env.gate);
    const run = new AbortController();
    const event = {
      type: 'tool_call',
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
    };
    expect(await onToolCall(event, { signal: run.signal })).toBeUndefined();
    expect(env.notices).toEqual([{ toolCallId: 'c1', toolName: 'bash', kind: 'command' }]);
    expect(
      await onToolCall(
        { type: 'tool_call', toolCallId: 'c2', toolName: 'read', input: { path: 'a' } },
        { signal: run.signal }
      )
    ).toBeUndefined();
    run.abort();
    expect(await onToolCall(event, { signal: run.signal })).toMatchObject({ block: true });
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('still notifies when the pi context has no usable signal', async () => {
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
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.request).not.toHaveBeenCalled();
  });
});
