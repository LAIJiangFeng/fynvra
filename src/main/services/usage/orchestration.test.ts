import type { Dispatch, Task } from '@fynvra/core';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  createFileAccumulator,
  type SessionUsage,
  type UsageContext,
} from './aggregate';

const at = (day: number, hour = 12) => new Date(2026, 3, day, hour).getTime();
const task = (id: string, status: Task['status']): Task => ({
  id,
  status,
  runId: 'run',
  title: 'private title',
  spec: 'private spec',
  roleId: 'worker',
  dependsOn: [],
});
const dispatch = (id: string, taskId: string, day = 3, workerSessionId = id): Dispatch => ({
  id,
  taskId,
  startedAt: at(day),
  settledAt: at(day, 13),
  outcome: 'succeeded',
  workerSessionId,
  worktreeId: 'wt',
  branch: 'private branch',
});
function file(sessionId: string, cost: number): SessionUsage {
  const accumulator = createFileAccumulator();
  // Lifetime cost, even when some work falls outside the cohort's calendar range.
  for (const day of [2, 3])
    accumulator.add(
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          timestamp: at(day),
          usage: { input: 100, cost: { total: cost / 2 } },
        },
      })
    );
  return { ...accumulator.finish(), sessionId };
}
function context(snapshot: OrchestrationSnapshotView): UsageContext {
  return {
    snapshots: [{ workspaceId: 'ws', snapshot }],
    workspaces: [{ id: 'ws', name: 'Workspace' }],
    sessions: [
      { id: 'one', roleId: 'worker', workspaceId: 'ws', dispatchId: 'one' },
      { id: 'reused', roleId: 'custom-worker', workspaceId: 'ws', dispatchId: 'retry' },
    ],
  };
}
function snapshot(): OrchestrationSnapshotView {
  return {
    runs: [],
    worktrees: [],
    messages: [],
    tasks: [
      task('single', 'completed'),
      task('multi', 'completed'),
      task('abandon', 'abandoned'),
      task('fail', 'failed'),
      task('active', 'in-progress'),
      task('old', 'completed'),
      task('future', 'completed'),
      task('queued', 'todo'),
    ],
    dispatches: [
      dispatch('one', 'single'),
      dispatch('first', 'multi', 3, 'reused'),
      { ...dispatch('retry', 'multi', 3, 'reused'), startedAt: at(3, 14) },
      dispatch('abandon', 'abandon'),
      { ...dispatch('fail', 'fail'), outcome: 'failed' },
      dispatch('active', 'active'),
      dispatch('old', 'old', 2),
      dispatch('old-retry', 'old', 3),
      dispatch('future', 'future', 4),
    ],
  };
}

describe('usage orchestration cohorts', () => {
  it('counts current outcomes, first-pass acceptance, attempts, range retries and linked lifetime worker cost', () => {
    const summary = aggregateUsage(
      [file('one', 4), file('reused', 8)],
      'today',
      at(3),
      context(snapshot())
    );
    expect(summary.orchestration).toEqual({
      dispatched: 5,
      completed: 2,
      abandoned: 1,
      failed: 1,
      rejected: 2,
      firstPassRate: 0.5,
      averageAttempts: 1.5,
      workerCostPerMergedTask: 6,
    });
    // The ordinary usage totals remain range filtered, unlike lifetime cost for the completed cohort.
    expect(summary.current.totals.cost).toBe(6);
    expect(JSON.stringify(summary)).not.toContain('private');
  });

  it('uses first startedAt, not settledAt, and includes start but excludes end; sorts attempts', () => {
    const state = snapshot();
    state.tasks = [task('start', 'completed'), task('end', 'abandoned'), task('earlier', 'failed')];
    state.dispatches = [
      { ...dispatch('retry', 'earlier'), startedAt: at(3, 15) },
      { ...dispatch('end', 'end'), startedAt: at(4, 0), settledAt: at(4, 1) },
      { ...dispatch('start', 'start'), startedAt: at(3, 0), settledAt: at(4, 13) },
      { ...dispatch('earlier', 'earlier', 2), settledAt: at(3, 14) },
    ];
    const stats = aggregateUsage([], 'today', at(3), context(state)).orchestration;
    expect(stats).toEqual({
      dispatched: 1,
      completed: 1,
      abandoned: 0,
      failed: 0,
      rejected: 1,
      firstPassRate: 1,
      averageAttempts: 1,
    });
    expect(stats.workerCostPerMergedTask).toBeUndefined();
  });

  it('omits ratios without completed tasks and omits cost if a worker transcript or registry link is missing', () => {
    const empty = aggregateUsage([], 'today', at(3)).orchestration;
    expect(empty).toEqual({ dispatched: 0, completed: 0, abandoned: 0, failed: 0, rejected: 0 });
    const ctx = context(snapshot());
    expect(
      aggregateUsage([file('one', 4)], 'today', at(3), ctx).orchestration.workerCostPerMergedTask
    ).toBeUndefined();
    ctx.sessions = ctx.sessions.filter((session) => session.id !== 'reused');
    expect(
      aggregateUsage([file('one', 4), file('reused', 8)], 'today', at(3), ctx).orchestration
        .workerCostPerMergedTask
    ).toBeUndefined();
    ctx.sessions = [{ id: 'one', roleId: 'worker', workspaceId: 'other', dispatchId: 'one' }];
    expect(
      aggregateUsage([file('one', 4), file('reused', 8)], 'today', at(3), ctx).orchestration
        .workerCostPerMergedTask
    ).toBeUndefined();
  });

  it('keeps task/dispatch joins scoped to each workspace', () => {
    const ctx = context(snapshot());
    ctx.snapshots = [
      {
        workspaceId: 'a',
        snapshot: {
          runs: [],
          tasks: [task('same', 'completed')],
          dispatches: [dispatch('a', 'same')],
          messages: [],
          worktrees: [],
        },
      },
      {
        workspaceId: 'b',
        snapshot: {
          runs: [],
          tasks: [task('same', 'failed')],
          dispatches: [dispatch('b', 'same')],
          messages: [],
          worktrees: [],
        },
      },
    ];
    expect(aggregateUsage([], 'today', at(3), ctx).orchestration).toMatchObject({
      dispatched: 2,
      completed: 1,
      failed: 1,
      rejected: 0,
      firstPassRate: 1,
      averageAttempts: 1,
    });
  });
});
