import type { Dispatch, Message } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  describeSubject,
  formatClock,
  formatDuration,
  formatRelative,
  isFromWorker,
  messageSummary,
  outputLineKind,
  reportOutcome,
} from './format';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    runId: 'run_1',
    dispatchId: 'dispatch_1',
    from: 'session_worker',
    to: 'session_coordinator',
    type: 'question',
    body: 'hello',
    createdAt: 0,
    ...overrides,
  };
}

const dispatch: Dispatch = {
  id: 'dispatch_1',
  taskId: 'task_1',
  workerSessionId: 'session_worker',
  worktreeId: 'worktree_1',
  branch: 'fynvra/x',
  startedAt: 0,
};

describe('formatDuration', () => {
  it('uses seconds, minutes and hours', () => {
    expect(formatDuration(-5)).toBe('0 秒');
    expect(formatDuration(42_900)).toBe('42 秒');
    expect(formatDuration(180_000)).toBe('3 分');
    expect(formatDuration(192_000)).toBe('3 分 12 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
    expect(formatDuration(7_200_000)).toBe('2 小时');
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime();
  it('describes recent times relative to now', () => {
    expect(formatRelative(now - 10_000, now)).toBe('刚刚');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 小时前');
  });

  it('falls back to a date for older times', () => {
    expect(formatRelative(new Date(2026, 9, 20, 9, 5, 7).getTime(), now)).toBe('10-20 09:05:07');
  });
});

describe('formatClock', () => {
  it('omits the date for today', () => {
    const now = new Date(2026, 9, 24, 23, 0, 0).getTime();
    expect(formatClock(new Date(2026, 9, 24, 8, 4, 2).getTime(), now)).toBe('08:04:02');
  });
});

describe('messages', () => {
  it('translates worker_done outcomes, including follow-up reports', () => {
    expect(describeSubject(message({ type: 'worker_done', subject: 'succeeded' }))).toBe('成功');
    expect(describeSubject(message({ type: 'worker_done', subject: 'failed (follow-up)' }))).toBe(
      '失败（追加）'
    );
    expect(describeSubject(message({ type: 'instruction', subject: 'review feedback' }))).toBe(
      'review feedback'
    );
    expect(describeSubject(message({}))).toBeUndefined();
    expect(reportOutcome(message({ type: 'worker_done', subject: 'failed (follow-up)' }))).toBe(
      'failed'
    );
    expect(reportOutcome(message({ type: 'reply', subject: 'succeeded' }))).toBeUndefined();
  });

  it('summarises a message on one line', () => {
    const done = message({ type: 'worker_done', subject: 'succeeded', body: 'did it\n\nFiles: a' });
    expect(messageSummary(done)).toBe('完成汇报·成功：did it Files: a');
    expect(messageSummary(message({ body: 'x'.repeat(100) }), 10)).toBe(`提问：${'x'.repeat(9)}…`);
  });

  it('tells worker messages from coordinator messages', () => {
    expect(isFromWorker(message({}), dispatch)).toBe(true);
    const reply = message({ type: 'reply', from: 'session_coordinator', to: 'session_worker' });
    expect(isFromWorker(reply, dispatch)).toBe(false);
    // 发送方对不上（如 Main 自己发的 escalation）时按类型
    expect(isFromWorker(message({ type: 'escalation', from: 'fynvra', to: 'x' }), dispatch)).toBe(
      true
    );
    expect(isFromWorker(message({ type: 'instruction', from: 'a', to: 'b' }), undefined)).toBe(
      false
    );
  });
});

describe('outputLineKind', () => {
  it('classifies the transcript markers written by Main', () => {
    expect(outputLineKind('plain assistant text')).toBe('text');
    expect(outputLineKind('[user] brief')).toBe('user');
    expect(outputLineKind('[tool] read {"path":"a"}')).toBe('tool');
    expect(outputLineKind('[tool done] read: ok')).toBe('tool-done');
    expect(outputLineKind('[tool error] bash: exit 1')).toBe('error');
    expect(outputLineKind('[error] model overloaded')).toBe('error');
    expect(outputLineKind('[approval] bash')).toBe('notice');
    expect(outputLineKind('[aborted]')).toBe('notice');
    expect(outputLineKind('[settled]')).toBe('settled');
    expect(outputLineKind('[1/3] step')).toBe('text');
  });
});
