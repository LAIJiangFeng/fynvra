import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiff, statSummary } from '../../components/orchestration/diff';
import {
  createMockOrchestrationApi,
  getOrchestrationApi,
  MOCK_IDS,
  MOCK_TIMELINE,
  type OrchestrationApi,
  usingOrchestrationMock,
} from './orchestration';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeBridge(): OrchestrationApi {
  return {
    snapshot: vi.fn(),
    readWorkerOutput: vi.fn(),
    reviewDiff: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  };
}

function flags(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('getOrchestrationApi', () => {
  it('uses window.fynvra.orchestration when preload exposes it', () => {
    const bridge = fakeBridge();
    vi.stubGlobal('fynvra', { orchestration: bridge });
    expect(getOrchestrationApi()).toBe(bridge);
    expect(usingOrchestrationMock()).toBe(false);
  });

  it('falls back to one shared in-memory mock without preload', () => {
    const api = getOrchestrationApi();
    expect(api).toBe(getOrchestrationApi());
    expect(usingOrchestrationMock()).toBe(true);
  });

  it('prefers the mock when the demo flag is set for this window', () => {
    vi.stubGlobal('fynvra', { orchestration: fakeBridge() });
    vi.stubGlobal('sessionStorage', flags({ 'fynvra.orchestration.demo': '1' }));
    expect(usingOrchestrationMock()).toBe(true);
    expect(getOrchestrationApi()).not.toBe((globalThis as { fynvra?: unknown }).fynvra);
  });
});

describe('createMockOrchestrationApi', () => {
  function setup(pageChars?: number) {
    let clock = 5_000_000;
    const api = createMockOrchestrationApi({ now: () => clock, latencyMs: 0, pageChars });
    return {
      api,
      advance(ms: number) {
        clock += ms;
      },
    };
  }

  async function readAll(api: OrchestrationApi, dispatchId: string) {
    let cursor = 0;
    let text = '';
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await api.readWorkerOutput({ dispatchId, cursor });
      if (!page.ok) throw new Error(page.error);
      text += page.text;
      cursor += page.text.length;
      if (cursor >= page.total) return { text, total: page.total, done: page.done };
    }
    throw new Error('output never ended');
  }

  it('starts with one run and a completed, an in-progress and an in-review task', async () => {
    const { api } = setup();
    const result = await api.snapshot('ws-1');
    if (!result.ok) throw new Error(result.error);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.workspaceId).toBe('ws-1');
    expect(result.tasks.map((task) => task.status)).toEqual([
      'completed',
      'in-progress',
      'in-review',
    ]);
    const running = result.dispatches.filter((dispatch) => dispatch.settledAt === undefined);
    expect(running.map((dispatch) => dispatch.id)).toEqual([MOCK_IDS.dispatches.inProgress]);
  });

  it('pages the worker output by cursor and keeps the pages contiguous', async () => {
    const { api } = setup(64);
    const first = await api.readWorkerOutput({
      dispatchId: MOCK_IDS.dispatches.completed,
      cursor: 0,
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.text).toHaveLength(64);
    expect(first.total).toBeGreaterThan(64);
    const all = await readAll(api, MOCK_IDS.dispatches.completed);
    expect(all.text).toHaveLength(all.total);
    expect(all.text.startsWith(first.text)).toBe(true);
    expect(all.done).toBe(true);
  });

  it('streams the in-progress output over time and settles it into review', async () => {
    const { api, advance } = setup();
    const before = await readAll(api, MOCK_IDS.dispatches.inProgress);
    expect(before.done).toBe(false);

    advance(MOCK_TIMELINE.reply + 1_000);
    const middle = await readAll(api, MOCK_IDS.dispatches.inProgress);
    expect(middle.total).toBeGreaterThan(before.total);
    expect(middle.text.startsWith(before.text)).toBe(true);
    const asked = await api.snapshot('ws-1');
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.messages.filter((m) => m.dispatchId === MOCK_IDS.dispatches.inProgress)).toEqual([
      expect.objectContaining({ type: 'question' }),
      expect.objectContaining({ type: 'reply', replyTo: 'msg_demo5' }),
    ]);

    advance(MOCK_TIMELINE.settle);
    const after = await readAll(api, MOCK_IDS.dispatches.inProgress);
    expect(after.done).toBe(true);
    expect(after.text.endsWith('[settled]\n')).toBe(true);
    const settled = await api.snapshot('ws-1');
    if (!settled.ok) throw new Error(settled.error);
    expect(settled.tasks.find((task) => task.id === MOCK_IDS.tasks.inProgress)?.status).toBe(
      'in-review'
    );
    expect(
      settled.dispatches.find((dispatch) => dispatch.id === MOCK_IDS.dispatches.inProgress)
    ).toMatchObject({ outcome: 'succeeded' });
  });

  it('serves a parseable diff whose files and stat agree with the patch', async () => {
    const { api } = setup();
    const result = await api.reviewDiff(MOCK_IDS.dispatches.inReview);
    if (!result.ok) throw new Error(result.error);
    const parsed = parseUnifiedDiff(result.diff);
    expect(parsed.map((file) => file.path)).toEqual(result.files);
    expect(parsed.map((file) => file.status)).toEqual([
      'modified',
      'modified',
      'added',
      'deleted',
      'renamed',
      'added',
    ]);
    const insertions = parsed.reduce((sum, file) => sum + file.additions, 0);
    const deletions = parsed.reduce((sum, file) => sum + file.deletions, 0);
    expect(statSummary(result.stat)).toBe(
      `6 files changed, ${insertions} insertions(+), ${deletions} deletions(-)`
    );
  });

  it('reports a cleaned-up worktree and unknown dispatches as errors', async () => {
    const { api } = setup();
    await expect(api.reviewDiff(MOCK_IDS.dispatches.completed)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already cleaned up'),
    });
    await expect(api.reviewDiff('dispatch_nope')).resolves.toMatchObject({ ok: false });
    await expect(
      api.readWorkerOutput({ dispatchId: 'dispatch_nope', cursor: 0 })
    ).resolves.toMatchObject({ ok: false });
  });

  it('pushes changed for the workspaces it served when a scripted event happens', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const api = createMockOrchestrationApi({ latencyMs: 0 });
    const changed = vi.fn();
    const unsubscribe = api.onChanged(changed);
    await api.snapshot('ws-1');

    vi.advanceTimersByTime(MOCK_TIMELINE.ask - 1);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith('ws-1');
    vi.advanceTimersByTime(MOCK_TIMELINE.settle);
    expect(changed).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });
});
