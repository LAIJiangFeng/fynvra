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
  TASK_STATUSES,
  THINKING_LEVELS,
  TOOL_POLICIES,
} from './guards';

describe('enum lists', () => {
  it('与 ARCHITECTURE §4 的联合类型逐项一致', () => {
    expect(APPROVAL_MODES).toEqual(['supervised', 'auto-edits', 'full']);
    expect(TOOL_POLICIES).toEqual(['all', 'readonly', 'orchestrator']);
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
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
});
