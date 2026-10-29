import type { Preferences, PreferencesResult } from '@shared/types/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function setup(initial: Partial<Preferences> = {}) {
  vi.resetModules();
  let preferences: Preferences = { theme: 'system', sidePanelOpen: true, ...initial };
  const get = vi.fn(async (): Promise<PreferencesResult> => ({ ok: true, preferences }));
  const update = vi.fn(async (patch: Partial<Preferences>): Promise<PreferencesResult> => {
    preferences = { ...preferences, ...patch };
    return { ok: true, preferences };
  });
  vi.stubGlobal('window', {
    fynvra: {
      settings: { get, update, onChanged: vi.fn(() => () => {}) },
      window: { platform: 'win32' },
      notifications: { test: vi.fn() },
      sessions: { sweep: vi.fn() },
    },
  });
  const { useGeneralPreferencesStore: store } = await import('./settings');
  await store.getState().load();
  return { store, get, update };
}
afterEach(() => vi.unstubAllGlobals());

describe('general compaction preferences', () => {
  it('defaults to ten minutes and writes only the timeout preference, preserving the selected strategy', async () => {
    const { store, update } = await setup({ compactionStrategy: 'magic-context' });
    expect(store.getState().compactionTimeoutMs).toBe(600_000);
    await store.getState().update({ compactionTimeoutMs: 30_000 });
    expect(update).toHaveBeenCalledExactlyOnceWith({ compactionTimeoutMs: 30_000 });
    expect(store.getState().compaction).toBe('magic-context');
    await store.getState().update({ foldHistoryTurns: true });
    expect(store.getState().compactionTimeoutMs).toBe(30_000);
  });

  it('reverts rejected timeout changes to Main values and exposes a save error', async () => {
    const { store, update } = await setup({ compactionTimeoutMs: 120_000 });
    update.mockResolvedValueOnce({ ok: false, error: 'save rejected' });
    await store.getState().update({ compactionTimeoutMs: 180_000 });
    expect(store.getState().compactionTimeoutMs).toBe(120_000);
    expect(store.getState().error).toContain('save rejected');
  });

  it('an older load cannot undo a newly saved strategy/timeout selection', async () => {
    const { store, get } = await setup();
    let finish!: (result: PreferencesResult) => void;
    get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const loading = store.getState().load();
    await store.getState().update({ compactionTimeoutMs: 1_800_000, compactionStrategy: 'off' });
    finish({
      ok: true,
      preferences: {
        theme: 'system',
        sidePanelOpen: true,
        compactionTimeoutMs: 600_000,
        compactionStrategy: 'native',
      },
    });
    await loading;
    expect(store.getState().compactionTimeoutMs).toBe(1_800_000);
    expect(store.getState().compaction).toBe('off');
  });
});
