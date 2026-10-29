import type { ChatMessage, SessionStatus } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunningSilence, type RunningActivity, runningActivityOf } from './runningSilence';

const assistant = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'reply',
  sessionId: 'session-a',
  role: 'assistant',
  text: '',
  toolCalls: [],
  createdAt: 0,
  streaming: true,
  ...patch,
});

interface State {
  sessionId: string;
  status: SessionStatus;
  messages: ChatMessage[];
}

const cleanups: (() => void)[] = [];
function watch(initial: Partial<State> = {}) {
  const state: State = {
    sessionId: 'session-a',
    status: 'running',
    messages: [],
    ...initial,
  };
  let visible: RunningActivity | undefined;
  const changed = vi.fn((next: RunningActivity | undefined) => {
    visible = next;
  });
  const silence = createRunningSilence(
    () => runningActivityOf(state.sessionId, state.status, state.messages),
    changed
  );
  silence.update();
  cleanups.push(silence.dispose);
  return {
    state,
    changed,
    get visible() {
      return visible !== undefined;
    },
    update(patch: Partial<State>) {
      Object.assign(state, patch);
      silence.update();
    },
    dispose: silence.dispose,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('running silence', () => {
  it('进入 running 后静默满 800ms 才显示，显示后不轮询', () => {
    const view = watch({ status: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
    view.update({ status: 'running' });
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    view.changed.mockClear();
    view.update({});
    vi.advanceTimersByTime(10_000);
    expect(view.changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('持续正文增长时不显示，已有正文停止增量后仍会显示', () => {
    const view = watch({ messages: [assistant({ text: '旧正文' })] });
    for (let index = 1; index <= 10; index++) {
      vi.advanceTimersByTime(200);
      view.update({ messages: [assistant({ text: `旧正文${'字'.repeat(index)}` })] });
      expect(view.visible).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    }
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(true);
  });

  it('已显示后正文到来立即隐藏，等长正文替换也重新计时', () => {
    const view = watch();
    vi.advanceTimersByTime(800);
    expect(view.visible).toBe(true);
    view.update({ messages: [assistant({ text: 'abc' })] });
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(800);
    expect(view.visible).toBe(true);
    view.update({ messages: [assistant({ text: 'xyz' })] });
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(true);
  });

  it('思考增量、工具运行/输出和空白占位不推迟静默提示', () => {
    const view = watch();
    for (let index = 1; index <= 4; index++) {
      vi.advanceTimersByTime(199);
      view.update({
        messages: [
          assistant({
            text: ' '.repeat(index),
            thinking: '思考'.repeat(index),
            toolCalls: [
              {
                id: 'command',
                name: 'bash',
                args: { command: 'pnpm test' },
                status: index < 4 ? 'running' : 'done',
                output: 'output'.repeat(index),
              },
            ],
          }),
        ],
      });
    }
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(4);
    expect(view.visible).toBe(true);
    view.update({ messages: [assistant({ thinking: '更多思考' })] });
    expect(view.visible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('旧正文之后出现工具/思考消息，以及 streaming 收尾均不重新计时', () => {
    const body = assistant({ text: '我来执行命令' });
    const view = watch({ messages: [body] });
    vi.advanceTimersByTime(400);
    view.update({
      messages: [{ ...body, streaming: false }, assistant({ id: 'next-reply', thinking: '思考' })],
    });
    vi.advanceTimersByTime(400);
    expect(view.visible).toBe(true);
    view.update({ messages: [{ ...body, streaming: false }] });
    expect(view.visible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('尾部用户回显不遮住仍在增长的 assistant 正文', () => {
    const pending = assistant({ id: 'pending', role: 'user', text: '下一条问题' });
    const view = watch({ messages: [assistant({ text: 'a' }), pending] });
    vi.advanceTimersByTime(700);
    view.update({ messages: [assistant({ text: 'ab' }), pending] });
    vi.advanceTimersByTime(700);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(100);
    expect(view.visible).toBe(true);
  });

  it.each(['idle', 'error', 'waiting-approval'] as const)(
    '阈值前进入 %s 立即取消；最后 streaming=false 不会启动新计时',
    (status) => {
      const body = assistant({ text: '最后正文' });
      const view = watch({ messages: [body] });
      vi.advanceTimersByTime(799);
      view.update({ status, messages: [{ ...body, streaming: false }] });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(view.visible).toBe(false);
    }
  );

  it.each(['idle', 'error', 'waiting-approval'] as const)(
    '已经显示时进入 %s 立即隐藏',
    (status) => {
      const view = watch();
      vi.advanceTimersByTime(800);
      view.update({ status });
      expect(view.visible).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['idle', 'error', 'waiting-approval'] as const)(
    '回调重新读取最新 %s 状态，即使订阅尚未通知也不闪现',
    (status) => {
      const view = watch();
      vi.advanceTimersByTime(799);
      view.state.status = status;
      vi.advanceTimersByTime(1);
      expect(view.visible).toBe(false);
    }
  );

  it('回调也核对最新正文，避免正文更新尚未通知时显示', () => {
    const view = watch();
    vi.advanceTimersByTime(799);
    view.state.messages = [assistant({ text: '刚到达的正文' })];
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(false);
  });

  it('切换 session 取消旧计时/显示，新 session 从零等待', () => {
    const view = watch();
    vi.advanceTimersByTime(799);
    view.update({ sessionId: 'session-b' });
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(true);
    view.update({ sessionId: 'session-a' });
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(true);
  });

  it('已取消的迟到回调不能污染重新运行的同一 session', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const view = watch();
    const late = timeout.mock.calls[0][0];
    if (typeof late !== 'function') throw new Error('Expected timeout callback');
    vi.advanceTimersByTime(799);
    view.update({ status: 'idle' });
    view.update({ status: 'running' });
    late();
    expect(view.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(799);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.visible).toBe(true);
  });

  it('卸载清理 timer，已排队的回调也不能再发布状态', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const view = watch();
    const late = timeout.mock.calls[0][0];
    if (typeof late !== 'function') throw new Error('Expected timeout callback');
    vi.advanceTimersByTime(799);
    view.dispose();
    view.changed.mockClear();
    expect(vi.getTimerCount()).toBe(0);
    late();
    vi.advanceTimersByTime(10_000);
    expect(view.changed).not.toHaveBeenCalled();
  });
});
