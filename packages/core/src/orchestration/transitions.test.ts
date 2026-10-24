import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from '../guards';
import type { Dispatch, Task, TaskStatus } from '../types';
import {
  applyTaskTransition,
  canTransitionTask,
  isDispatchSettled,
  isTerminalTaskStatus,
  settleDispatch,
  TASK_TRANSITIONS,
} from './transitions';

const LEGAL: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in-progress', 'abandoned'],
  'in-progress': ['in-review', 'failed', 'abandoned'],
  'in-review': ['completed', 'in-progress', 'failed', 'abandoned'],
  failed: ['in-progress', 'abandoned'],
  completed: [],
  abandoned: [],
};

const task: Task = {
  id: 'task_1',
  runId: 'run_1',
  title: 'Add parser',
  spec: '...',
  roleId: 'worker',
  status: 'todo',
  dependsOn: [],
};

const dispatch: Dispatch = {
  id: 'dispatch_1',
  taskId: 'task_1',
  workerSessionId: 'session_w',
  worktreeId: 'wt_1',
  branch: 'fynvra/add-parser',
  startedAt: 1_000,
};

describe('canTransitionTask', () => {
  it('迁移表与设计一致（逐对穷举 6×6）', () => {
    expect(TASK_TRANSITIONS).toEqual(LEGAL);
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTask(from, to), `${from} → ${to}`).toBe(LEGAL[from].includes(to));
      }
    }
  });

  it('未知状态一律不可迁移', () => {
    expect(canTransitionTask('bogus' as TaskStatus, 'todo')).toBe(false);
    expect(canTransitionTask('todo', 'bogus' as TaskStatus)).toBe(false);
    expect(canTransitionTask('toString' as TaskStatus, 'todo')).toBe(false);
  });

  it('只有 completed / abandoned 是终态', () => {
    expect(TASK_STATUSES.filter(isTerminalTaskStatus)).toEqual(['completed', 'abandoned']);
  });
});

describe('applyTaskTransition', () => {
  it('合法迁移返回新对象，不修改入参', () => {
    const result = applyTaskTransition(task, 'in-progress');
    expect(result).toEqual({ ok: true, task: { ...task, status: 'in-progress' } });
    expect(result.ok && result.task).not.toBe(task);
    expect(task.status).toBe('todo');
  });

  it.each<[TaskStatus, TaskStatus]>([
    ['todo', 'completed'],
    ['todo', 'in-review'],
    ['todo', 'todo'],
    ['in-progress', 'completed'],
    ['completed', 'in-progress'],
    ['abandoned', 'todo'],
    ['failed', 'completed'],
  ])('非法迁移 %s → %s 返回错误而不是抛异常', (from, to) => {
    const result = applyTaskTransition({ ...task, status: from }, to);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`${from} → ${to}`);
    expect(!result.ok && result.error).toContain(task.id);
  });

  it('目标状态不是合法 TaskStatus 时返回错误', () => {
    const result = applyTaskTransition(task, 'done' as TaskStatus);
    expect(!result.ok && result.error).toMatch(/unknown task status/);
  });
});

describe('settleDispatch', () => {
  it('写入结算时间、结果、总结和改动文件，不修改入参', () => {
    const files = ['src/a.ts'];
    const result = settleDispatch(dispatch, 'succeeded', 'Done.', files, 5_000);
    expect(result).toEqual({
      ok: true,
      dispatch: {
        ...dispatch,
        settledAt: 5_000,
        outcome: 'succeeded',
        summary: 'Done.',
        filesModified: ['src/a.ts'],
      },
    });
    files.push('src/b.ts');
    expect(result.ok && result.dispatch.filesModified).toEqual(['src/a.ts']);
    expect(isDispatchSettled(dispatch)).toBe(false);
  });

  it('未给 filesModified 时不写该字段；未给 now 时用当前时间', () => {
    const before = Date.now();
    const result = settleDispatch(dispatch, 'failed', 'Tests do not pass.');
    if (!result.ok) throw new Error(result.error);
    expect('filesModified' in result.dispatch).toBe(false);
    expect(result.dispatch.settledAt).toBeGreaterThanOrEqual(before);
    expect(isDispatchSettled(result.dispatch)).toBe(true);
  });

  it('已结算的 dispatch 不能再次结算', () => {
    const first = settleDispatch(dispatch, 'succeeded', 'Done.', [], 5_000);
    if (!first.ok) throw new Error(first.error);
    const second = settleDispatch(first.dispatch, 'failed', 'Again', [], 6_000);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toMatch(/already settled/);
  });

  it('非法 outcome 返回错误', () => {
    const result = settleDispatch(dispatch, 'maybe' as 'failed', 'x');
    expect(!result.ok && result.error).toMatch(/outcome/);
  });
});
