import type { IpcResult } from '@shared/types/ipc';
import type { SessionChanges, SessionChangesInput } from '@shared/types/orchestration';
import { describe, expect, it, vi } from 'vitest';
import { diffSourceKey } from './diffTabs';
import { createSessionChangesStore } from './sessionChanges';

const data = (branch: string): IpcResult<SessionChanges> => ({
  ok: true,
  availability: 'available',
  branch,
  headCommit: 'a'.repeat(40),
  baseCommit: 'b'.repeat(40),
  comparison: { kind: 'latest-commit' },
  files: [`${branch}.txt`],
  diff: branch,
  stat: '',
  commits: [],
  uncommitted: { available: true, files: [], diff: '' },
});
const key = (input: SessionChangesInput) => diffSourceKey({ kind: 'session', ...input });
function deferred() {
  let resolve!: (result: IpcResult<SessionChanges>) => void;
  const promise = new Promise<IpcResult<SessionChanges>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('session changes store', () => {
  it('isolates workspace main, two conversations, and another workspace with late responses', async () => {
    const calls = Array.from({ length: 4 }, deferred);
    const api = {
      changes: vi.fn((_input: SessionChangesInput) => {
        const call = calls[api.changes.mock.calls.length - 1];
        if (!call) throw new Error('unexpected call');
        return call.promise;
      }),
    };
    const store = createSessionChangesStore(api);
    const sources = [
      { workspaceId: 'ws' },
      { workspaceId: 'ws', sessionId: 'first' },
      { workspaceId: 'ws', sessionId: 'second' },
      { workspaceId: 'other', sessionId: 'first' },
    ];
    const pending = sources.map((input) => store.getState().load(input));
    calls[2]?.resolve(data('second'));
    await pending[2];
    calls[0]?.resolve(data('main'));
    calls[1]?.resolve(data('first'));
    calls[3]?.resolve(data('other'));
    await Promise.all(pending);
    for (const [index, branch] of ['main', 'first', 'second', 'other'].entries()) {
      const source = sources[index];
      if (!source) throw new Error('fixture');
      expect(store.getState().entries[key(source)]).toMatchObject({
        status: 'ready',
        data: { branch },
      });
    }
    expect(api.changes.mock.calls.map(([input]) => input)).toEqual(sources);
  });

  it('deduplicates reads and ignores the response superseded by a refresh or a return to the conversation', async () => {
    const first = deferred();
    const fresh = deferred();
    const api = {
      changes: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(fresh.promise),
    };
    const store = createSessionChangesStore(api);
    const source = { workspaceId: 'ws', sessionId: 'worker' };
    const pending = store.getState().load(source);
    expect(store.getState().load(source)).toBe(pending);
    expect(store.getState().load(source, true)).toBe(pending);
    expect(store.getState().load(source, true)).toBe(pending);
    expect(api.changes).toHaveBeenCalledTimes(1);
    first.resolve(data('stale'));
    await Promise.resolve();
    expect(store.getState().entries[key(source)]).toEqual({ status: 'loading' });
    expect(api.changes).toHaveBeenCalledTimes(2);
    fresh.resolve(data('fresh'));
    await pending;
    expect(store.getState().entries[key(source)]).toMatchObject({
      status: 'ready',
      data: { branch: 'fresh' },
      refreshing: false,
    });
    await store.getState().load(source);
    expect(api.changes).toHaveBeenCalledTimes(2);
  });

  it('surfaces refresh errors and supports retry rather than presenting old changes as current', async () => {
    const api = {
      changes: vi
        .fn()
        .mockResolvedValueOnce(data('main'))
        .mockResolvedValueOnce({ ok: false, error: 'removed directory' })
        .mockRejectedValueOnce(new Error('IPC failed'))
        .mockResolvedValueOnce(data('recovered')),
    };
    const store = createSessionChangesStore(api);
    const source = { workspaceId: 'ws' };
    await store.getState().load(source);
    await store.getState().load(source, true);
    expect(store.getState().entries[key(source)]).toEqual({
      status: 'error',
      error: 'removed directory',
    });
    await store.getState().load(source);
    expect(store.getState().entries[key(source)]).toEqual({ status: 'error', error: 'IPC failed' });
    await store.getState().load(source);
    expect(store.getState().entries[key(source)]).toMatchObject({
      status: 'ready',
      data: { branch: 'recovered' },
    });
  });
});
