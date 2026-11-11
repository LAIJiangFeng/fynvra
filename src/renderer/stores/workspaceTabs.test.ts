import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalsStore } from './terminals';
import {
  ensureWorkspaceTabs,
  forgetWorkspaceTabs,
  moveWorkspaceTab,
  rememberWorkspaceSession,
  useWorkspaceTabsStore,
} from './workspaceTabs';

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));

beforeEach(() => useWorkspaceTabsStore.setState({ views: {}, closing: false }));

describe('workspace tab view updates', () => {
  it('initializes a missing view and applies the requested session', () => {
    rememberWorkspaceSession('workspace', 'session');
    expect(useWorkspaceTabsStore.getState().views.workspace).toEqual({
      order: ['chat'],
      active: 'chat',
      ready: false,
      error: null,
      warning: null,
      sessionId: 'session',
    });
  });

  it('preserves restored state and other workspaces when updating an existing view', () => {
    const restored = {
      order: ['chat', 'file:a'],
      active: 'file:a',
      ready: true,
      error: 'save failed',
      warning: 'recovered snapshot',
      sessionId: 'previous',
    };
    useWorkspaceTabsStore.setState({ views: { workspace: restored, other: restored } });
    rememberWorkspaceSession('workspace', null);
    moveWorkspaceTab('workspace', 'file:a', 'chat', false);
    expect(useWorkspaceTabsStore.getState().views.workspace).toEqual({
      ...restored,
      order: ['file:a', 'chat'],
      sessionId: null,
    });
    expect(useWorkspaceTabsStore.getState().views.other).toBe(restored);
  });
});

const TERM = '00000000-0000-4000-8000-000000000001';

describe('terminal changes', () => {
  it('only reconcile and persist the workspace that owns the terminal', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_request: { workspaceId: string }) => ({ ok: true }));
    const snapshot = { version: 1, tabs: [], active: 'chat', sessionId: null };
    vi.stubGlobal('window', {
      fynvra: {
        files: {},
        workspaceUi: { load: async () => ({ ok: true, token: 't', snapshot }), save },
      },
    });
    try {
      await Promise.all([ensureWorkspaceTabs('a'), ensureWorkspaceTabs('b')]);
      await vi.advanceTimersByTimeAsync(2000);
      save.mockClear();
      const viewB = useWorkspaceTabsStore.getState().views.b;

      useTerminalsStore.setState((state) => ({
        tabs: [...state.tabs, { id: TERM, workspaceId: 'a', number: 1, exited: false }],
      }));
      expect(useWorkspaceTabsStore.getState().views.a.order).toEqual(['chat', `terminal:${TERM}`]);
      expect(useWorkspaceTabsStore.getState().views.b).toBe(viewB);
      await vi.advanceTimersByTimeAsync(2000);
      expect(useWorkspaceTabsStore.getState().views.a.error).toBeNull();
      expect(save.mock.calls.map(([request]) => request.workspaceId)).toEqual(['a']);
    } finally {
      useTerminalsStore.setState({ tabs: [], selected: {} });
      forgetWorkspaceTabs('a');
      forgetWorkspaceTabs('b');
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
