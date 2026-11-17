import type { SessionStatus, SessionSummary } from '@shared/types/chat';
import { DEFAULT_WATCHDOG_PREFERENCES, type WatchdogPreferences } from '@shared/types/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostService, SessionObserver } from './agentHost';
import { installSessionWatchdog } from './watchdog';

const MAIN = 'session_main';
const INTERVAL = 60_000;

type Event = Parameters<NonNullable<SessionObserver['event']>>[0]['event'];

function fakes(overrides: Partial<WatchdogPreferences> = {}) {
  const prefs: WatchdogPreferences = {
    ...DEFAULT_WATCHDOG_PREFERENCES,
    enabled: true,
    ...overrides,
  };
  const sessions = new Map<string, SessionSummary>();
  const observers = new Set<SessionObserver>();
  const add = (id: string, extra: Partial<SessionSummary> = {}) => {
    const session = { id, roleId: 'orchestrator', status: 'running', ...extra } as SessionSummary;
    sessions.set(id, session);
    return session;
  };
  const activity = (id: string, action: 'prompt' | 'abort' | 'idle' | 'resume') => {
    for (const observer of observers) observer.activity?.(id, action);
  };
  const emit = (id: string, event: Event) => {
    for (const observer of observers) observer.event?.({ sessionId: id, event });
  };
  const agentHost = {
    get: (id: string) => sessions.get(id),
    observe: (observer: SessionObserver) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    abort: vi.fn<AgentHostService['abort']>(async (id) => {
      activity(id, 'abort');
      return { ok: true };
    }),
    resumeAfterInterruption: vi.fn<AgentHostService['resumeAfterInterruption']>(
      async (id, _text, options) => {
        const session = sessions.get(id);
        const ok =
          session?.status === 'error' || (options?.fromIdle === true && session?.status === 'idle');
        if (!session || !ok) return { ok: true, delivered: false };
        session.status = 'running';
        activity(id, 'resume');
        return { ok: true, delivered: true };
      }
    ),
  };
  const log = vi.fn();
  const stop = installSessionWatchdog({
    agentHost,
    preferences: () => prefs,
    isOrchestrator: (session) => session.roleId === 'orchestrator',
    log,
  });
  /** 模型错误的完整序列：error → agent_settled{aborted:false} → 状态 error */
  const modelError = (id: string, message = 'network down') => {
    emit(id, { type: 'error', source: 'model', message, seq: 1 });
    emit(id, { type: 'agent_settled', aborted: false, seq: 2 });
    const session = sessions.get(id);
    if (session) session.status = 'error';
  };
  const setStatus = (id: string, status: SessionStatus) => {
    const session = sessions.get(id);
    if (session) session.status = status;
  };
  return { prefs, sessions, add, emit, activity, agentHost, log, stop, modelError, setStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const resumed = (f: ReturnType<typeof fakes>) => f.agentHost.resumeAfterInterruption.mock.calls;

describe('installSessionWatchdog：错误恢复', () => {
  it('模型错误在一个间隔后被恢复，消息里带次数与原因', async () => {
    const f = fakes();
    f.add(MAIN);
    f.modelError(MAIN, 'ECONNRESET');
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(resumed(f)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(resumed(f)).toHaveLength(1);
    const text = resumed(f)[0]?.[1] ?? '';
    expect(text).toContain('attempt 1/10');
    expect(text).toContain('ECONNRESET');
    expect(text).toContain('not a message from the user');
  });

  it('原因截断到 500 字', async () => {
    const f = fakes();
    f.add(MAIN);
    f.modelError(MAIN, 'x'.repeat(800));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)[0]?.[1]).toContain(`${'x'.repeat(500)}…`);
    expect(resumed(f)[0]?.[1]).not.toContain('x'.repeat(501));
  });

  it('守护关闭时不恢复；开启前发生的失败开启后也不恢复', async () => {
    const f = fakes({ enabled: false });
    f.add(MAIN);
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    f.prefs.enabled = true;
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(resumed(f)).toHaveLength(0);
  });

  it('开启期间记录的失败在关闭期间作废，重新开启也不复活', async () => {
    const f = fakes({ intervalSeconds: 600 });
    f.add(MAIN);
    f.modelError(MAIN);
    f.prefs.enabled = false;
    await vi.advanceTimersByTimeAsync(600_000);
    f.prefs.enabled = true;
    await vi.advanceTimersByTimeAsync(600_000 * 3);
    expect(resumed(f)).toHaveLength(0);
  });

  it('用户点停止（idle）不恢复', async () => {
    const f = fakes();
    f.add(MAIN);
    f.emit(MAIN, { type: 'error', source: 'host', message: 'boom', seq: 1 });
    f.activity(MAIN, 'abort');
    f.emit(MAIN, { type: 'agent_settled', aborted: true, seq: 2 });
    f.setStatus(MAIN, 'idle');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(resumed(f)).toHaveLength(0);
  });

  it('已归档、派发出的 worker 不恢复', async () => {
    const f = fakes({ scope: 'all' });
    f.add('archived', { archivedAt: 1 });
    f.add('worker', { roleId: 'worker', dispatchId: 'd_1', parentSessionId: MAIN });
    f.modelError('archived');
    f.modelError('worker');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(resumed(f)).toHaveLength(0);
  });

  it("scope 为 'orchestrator' 时不恢复普通角色，为 'all' 时恢复", async () => {
    const f = fakes();
    f.add('plain', { roleId: 'worker' });
    f.modelError('plain');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(resumed(f)).toHaveLength(0);
    f.prefs.scope = 'all';
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f).map(([id]) => id)).toEqual(['plain']);
  });

  it('触发开关关掉时对应错误不恢复；compaction 错误不恢复', async () => {
    const f = fakes({ onModelError: false, onCrash: false });
    f.add('model');
    f.add('crash');
    f.add('compaction');
    f.modelError('model');
    f.emit('crash', { type: 'error', source: 'host', message: 'crashed', seq: 1 });
    f.emit('crash', { type: 'agent_settled', aborted: true, seq: 2 });
    f.setStatus('crash', 'error');
    f.emit('compaction', { type: 'error', source: 'compaction', message: 'too big', seq: 1 });
    f.setStatus('compaction', 'error');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(resumed(f)).toHaveLength(0);
    f.prefs.onCrash = true;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f).map(([id]) => id)).toEqual(['crash']);
  });

  it('需要上下文恢复的会话不恢复', async () => {
    const f = fakes();
    f.add(MAIN, {
      contextRuntime: { recoveryRequired: true } as SessionSummary['contextRuntime'],
    });
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(resumed(f)).toHaveLength(0);
  });

  it('退避按次数增长，达到 maxAttempts 后停止；正常结束一轮后计数清零', async () => {
    const f = fakes({ maxAttempts: 3 });
    f.add(MAIN);
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(1);
    // 恢复后又失败：要等 2 个间隔
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(2);
    expect(resumed(f)[1]?.[1]).toContain('attempt 2/3');
    // 第三次：等 4 个间隔
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(resumed(f)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(3);
    // 达到上限：不再恢复，记一次日志
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL * 60);
    expect(resumed(f)).toHaveLength(3);
    expect(f.log.mock.calls.filter(([m]) => String(m).includes('reached 3'))).toHaveLength(1);
    // 用户继续，这一轮正常结束：计数清零，之后的失败又能恢复
    f.activity(MAIN, 'prompt');
    f.setStatus(MAIN, 'running');
    f.emit(MAIN, { type: 'agent_settled', aborted: false, seq: 3 });
    f.setStatus(MAIN, 'idle');
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(4);
    expect(resumed(f)[3]?.[1]).toContain('attempt 1/3');
  });

  it('发送失败只记日志，下一次检查再试', async () => {
    const f = fakes();
    f.add(MAIN);
    f.agentHost.resumeAfterInterruption.mockResolvedValueOnce({ ok: false, error: 'offline' });
    f.modelError(MAIN);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('offline'));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(2);
    expect(resumed(f)[1]?.[1]).toContain('attempt 1/10');
  });

  it('停止后不再检查', async () => {
    const f = fakes();
    f.add(MAIN);
    f.modelError(MAIN);
    f.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(resumed(f)).toHaveLength(0);
  });
});

describe('installSessionWatchdog：卡住检测', () => {
  const STALL = 10 * 60_000;

  it('没有正在执行的工具且超过阈值时中止，范围内会话随后被自动恢复', async () => {
    const f = fakes({ onStall: true, stallMinutes: 10 });
    f.add(MAIN);
    f.activity(MAIN, 'prompt');
    // 第一次检查只开始计时
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(STALL - INTERVAL);
    expect(f.agentHost.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.agentHost.abort).toHaveBeenCalledWith(MAIN);
    // 中止后回到 idle：按间隔自动恢复
    f.emit(MAIN, { type: 'agent_settled', aborted: true, seq: 1 });
    f.setStatus(MAIN, 'idle');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumed(f)).toHaveLength(1);
    expect(resumed(f)[0]?.[1]).toContain('stalled');
    expect(resumed(f)[0]?.[2]).toEqual({ fromIdle: true });
  });

  it('有正在执行的工具时不中止；有新事件时重新计时', async () => {
    const f = fakes({ onStall: true, stallMinutes: 10 });
    f.add(MAIN);
    f.emit(MAIN, {
      type: 'tool_start',
      toolCallId: 't1',
      toolName: 'wait_for_workers',
      args: {},
      seq: 1,
    });
    await vi.advanceTimersByTimeAsync(STALL * 3);
    expect(f.agentHost.abort).not.toHaveBeenCalled();
    f.emit(MAIN, {
      type: 'tool_end',
      toolCallId: 't1',
      toolName: 'wait_for_workers',
      isError: false,
      output: '',
      outputTruncated: false,
      seq: 2,
    });
    await vi.advanceTimersByTimeAsync(STALL - INTERVAL);
    expect(f.agentHost.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.agentHost.abort).toHaveBeenCalledTimes(1);
  });

  it('onStall 关闭时不中止；派发的 worker 被中止但不恢复', async () => {
    const off = fakes({ stallMinutes: 10 });
    off.add(MAIN);
    off.activity(MAIN, 'prompt');
    await vi.advanceTimersByTimeAsync(STALL * 3);
    expect(off.agentHost.abort).not.toHaveBeenCalled();
    off.stop();

    const f = fakes({ onStall: true, stallMinutes: 10 });
    f.add('worker', { roleId: 'worker', dispatchId: 'd_1', parentSessionId: MAIN });
    f.activity('worker', 'prompt');
    await vi.advanceTimersByTimeAsync(STALL + INTERVAL);
    expect(f.agentHost.abort).toHaveBeenCalledWith('worker');
    f.setStatus('worker', 'idle');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(resumed(f)).toHaveLength(0);
  });

  it('等审批的会话不算卡住', async () => {
    const f = fakes({ onStall: true, stallMinutes: 10 });
    f.add(MAIN, { status: 'waiting-approval' });
    f.activity(MAIN, 'prompt');
    await vi.advanceTimersByTimeAsync(STALL * 3);
    expect(f.agentHost.abort).not.toHaveBeenCalled();
  });
});
