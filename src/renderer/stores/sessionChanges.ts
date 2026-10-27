import { errorMessage } from '@shared/guards';
import type { SessionChanges, SessionChangesInput } from '@shared/types/orchestration';
import { create } from 'zustand';
import { getOrchestrationApi, type OrchestrationApi } from '../lib/api/orchestration';
import { type DiffSource, diffSourceKey } from './diffTabs';
import { type DiffEntry, useOrchestrationStore } from './orchestration';

export type SessionChangesEntry =
  | { status: 'loading' }
  | { status: 'ready'; data: SessionChanges; refreshing: boolean }
  | { status: 'error'; error: string };

interface ChangesState {
  entries: Record<string, SessionChangesEntry>;
  load(input: SessionChangesInput, force?: boolean): Promise<void>;
}

/** Per-source caches: a late response can never replace another conversation's changes. */
export function createSessionChangesStore(api: Pick<OrchestrationApi, 'changes'>) {
  const running = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  return create<ChangesState>()((set, get) => ({
    entries: {},
    load(input, force = false) {
      const key = diffSourceKey({ kind: 'session', ...input });
      if (force) generations.set(key, (generations.get(key) ?? 0) + 1);
      const pending = running.get(key);
      if (pending) return pending;
      const current = get().entries[key];
      if (!force && current?.status === 'ready') return Promise.resolve();
      const put = (entry: SessionChangesEntry) =>
        set((state) => ({ entries: { ...state.entries, [key]: entry } }));
      put(current?.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' });
      const request = (async () => {
        for (;;) {
          const generation = generations.get(key);
          let next: SessionChangesEntry;
          try {
            const result = await api.changes(input);
            next = result.ok
              ? { status: 'ready', data: result, refreshing: false }
              : { status: 'error', error: result.error };
          } catch (error) {
            next = { status: 'error', error: errorMessage(error) };
          }
          if (generation !== generations.get(key)) continue;
          put(next);
          break;
        }
      })().finally(() => running.delete(key));
      running.set(key, request);
      return request;
    },
  }));
}

export const useSessionChangesStore = createSessionChangesStore(getOrchestrationApi());

export function loadSourceDiff(source: DiffSource, force = false): Promise<void> {
  return source.kind === 'session'
    ? useSessionChangesStore.getState().load(
        {
          workspaceId: source.workspaceId,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        },
        force
      )
    : useOrchestrationStore.getState().loadDiff(source.dispatchId, { force });
}

export function useSourceDiff(source: DiffSource): SessionChangesEntry | DiffEntry | undefined {
  const current = useSessionChangesStore((state) => state.entries[diffSourceKey(source)]);
  const historical = useOrchestrationStore((state) =>
    source.kind === 'dispatch' ? state.diffs[source.dispatchId] : undefined
  );
  return source.kind === 'session' ? current : historical;
}
