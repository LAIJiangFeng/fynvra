import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODES,
  DISPATCH_OUTCOMES,
  isApprovalMode,
  isDispatchOutcome,
  isMessageType,
  isTaskStatus,
  isThinkingLevel,
  isToolPolicy,
  MESSAGE_TYPES,
  normalizeThinkingLevel,
  TASK_STATUSES,
  THINKING_LEVELS,
  TOOL_POLICIES,
} from './guards';

describe('enum lists', () => {
  it('与 ARCHITECTURE §4 的联合类型逐项一致', () => {
    expect(APPROVAL_MODES).toEqual(['supervised', 'auto-edits', 'full']);
    expect(TOOL_POLICIES).toEqual(['all', 'readonly', 'orchestrator']);
    // 与 pi 的档位同一组、同一顺序（由低到高），含 pi 的 max
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(TASK_STATUSES).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'completed',
      'failed',
      'abandoned',
    ]);
    expect(MESSAGE_TYPES).toEqual([
      'worker_done',
      'question',
      'reply',
      'escalation',
      'heartbeat',
      'instruction',
    ]);
    expect(DISPATCH_OUTCOMES).toEqual(['succeeded', 'failed']);
  });
});

describe('guards', () => {
  const cases = [
    [isApprovalMode, APPROVAL_MODES],
    [isToolPolicy, TOOL_POLICIES],
    [isThinkingLevel, THINKING_LEVELS],
    [isTaskStatus, TASK_STATUSES],
    [isMessageType, MESSAGE_TYPES],
    [isDispatchOutcome, DISPATCH_OUTCOMES],
  ] as const;

  it.each(cases)('接受每个合法成员', (guard, members) => {
    for (const member of members) expect(guard(member)).toBe(true);
  });

  it.each(cases)('拒绝非成员、非字符串与原型链上的键', (guard) => {
    for (const value of ['', 'ALL', 'unknown', 'toString', '__proto__', 1, null, undefined, {}]) {
      expect(guard(value)).toBe(false);
    }
  });

  it('isThinkingLevel 不把别名 none 当成档位（none 只经 normalizeThinkingLevel 归一）', () => {
    expect(isThinkingLevel('none')).toBe(false);
  });
});

describe('normalizeThinkingLevel', () => {
  it('合法档位原样返回（含 max）', () => {
    for (const level of THINKING_LEVELS) expect(normalizeThinkingLevel(level)).toBe(level);
  });

  it('none 是「关闭」的别名（OpenAI 的叫法），归一到 off', () => {
    expect(normalizeThinkingLevel('none')).toBe('off');
  });

  it('其他值一律 undefined：大小写不同、未知名字、非字符串、原型链上的键', () => {
    for (const value of ['None', 'OFF', 'Max', 'ultra', '', 'toString', '__proto__', 1, null, {}]) {
      expect(normalizeThinkingLevel(value)).toBeUndefined();
    }
  });
});
