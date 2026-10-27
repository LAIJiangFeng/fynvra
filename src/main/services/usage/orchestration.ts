import type { Dispatch } from '@fynvra/core';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import type { UsageOrchestration } from '@shared/types/usage';
import type { SessionUsage, UsageSession } from './aggregate';

export interface UsageSnapshot {
  workspaceId: string;
  snapshot: OrchestrationSnapshotView;
}

/** Tasks have no merge/abandon timestamp: report current outcomes of the first-dispatch cohort. */
export function aggregateOrchestration(
  snapshots: readonly UsageSnapshot[],
  files: readonly SessionUsage[],
  sessions: ReadonlyMap<string, UsageSession>,
  start: number,
  end: number
): UsageOrchestration {
  const result: UsageOrchestration = {
    dispatched: 0,
    completed: 0,
    abandoned: 0,
    failed: 0,
    rejected: 0,
  };
  const inRange = (at: number) => at >= start && at < end;
  const bySession = new Map(files.map((file) => [file.sessionId, file]));
  let firstPass = 0;
  let attempts = 0;
  let workerCost = 0;
  let completeCost = true;
  for (const { workspaceId, snapshot } of snapshots) {
    const byTask = new Map<string, Dispatch[]>();
    for (const dispatch of snapshot.dispatches) {
      const entries = byTask.get(dispatch.taskId) ?? [];
      entries.push(dispatch);
      byTask.set(dispatch.taskId, entries);
    }
    for (const entries of byTask.values()) {
      entries.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      result.rejected += entries.slice(1).filter((dispatch) => inRange(dispatch.startedAt)).length;
    }
    for (const task of snapshot.tasks) {
      const entries = byTask.get(task.id);
      if (!entries?.length || !inRange(entries[0].startedAt)) continue;
      result.dispatched += 1;
      if (task.status === 'abandoned' || task.status === 'failed') result[task.status] += 1;
      if (task.status !== 'completed') continue;
      result.completed += 1;
      attempts += entries.length;
      if (entries.length === 1) firstPass += 1;
      // reject_work can reuse the same worker session; count its full transcript only once.
      const dispatchIds = new Set(entries.map((dispatch) => dispatch.id));
      for (const sessionId of new Set(entries.map((dispatch) => dispatch.workerSessionId))) {
        const session = sessions.get(sessionId);
        const file = bySession.get(sessionId);
        if (
          !file?.days.length ||
          session?.workspaceId !== workspaceId ||
          !session.dispatchId ||
          !dispatchIds.has(session.dispatchId)
        ) {
          completeCost = false;
          continue;
        }
        workerCost += file.days.reduce((sum, day) => sum + day.totals.cost, 0);
      }
    }
  }
  if (result.completed > 0) {
    result.firstPassRate = firstPass / result.completed;
    result.averageAttempts = attempts / result.completed;
    if (completeCost) result.workerCostPerMergedTask = workerCost / result.completed;
  }
  return result;
}
