import { beforeEach, describe, expect, it, vi } from 'vitest';
import { moveWorkspaceTab, rememberWorkspaceSession, useWorkspaceTabsStore } from './workspaceTabs';

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
