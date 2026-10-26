import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerActionHandler, runAction } from './handlers';
import {
  revealSessionListThen,
  type SessionListAction,
  type SessionListLayout,
  sessionListHidden,
} from './sessionListReveal';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('sessionListHidden', () => {
  it('选中了工作区，但左栏收起或它的会话列表折叠着：会话分组不在界面上', () => {
    expect(
      sessionListHidden({ workspaceSelected: true, sidebarOpen: false, sessionsCollapsed: false })
    ).toBe(true);
    expect(
      sessionListHidden({ workspaceSelected: true, sidebarOpen: true, sessionsCollapsed: true })
    ).toBe(true);
    expect(
      sessionListHidden({ workspaceSelected: true, sidebarOpen: false, sessionsCollapsed: true })
    ).toBe(true);
  });

  it('会话分组在界面上，或没选中工作区（展开了也没有会话分组）', () => {
    expect(
      sessionListHidden({ workspaceSelected: true, sidebarOpen: true, sessionsCollapsed: false })
    ).toBe(false);
    expect(
      sessionListHidden({ workspaceSelected: false, sidebarOpen: false, sessionsCollapsed: false })
    ).toBe(false);
    expect(
      sessionListHidden({ workspaceSelected: false, sidebarOpen: true, sessionsCollapsed: true })
    ).toBe(false);
  });
});

const ACTIONS: SessionListAction[] = ['new-session', 'search-sessions'];

/**
 * 模拟界面的一次次提交：会话分组不在界面上时 KeybindingProvider 登记兜底；
 * 会话分组挂载着（选中了工作区、左栏展开、列表没折叠）时 NewSessionButton / SessionSearchButton
 * 登记原来的处理函数。React 先跑清理（卸载、兜底停用）再跑挂载的效果，这里同样先注销再登记。
 */
function setup(initial: Partial<SessionListLayout> = {}, options: { syncCommit?: boolean } = {}) {
  const calls: string[] = [];
  const layout: SessionListLayout = {
    workspaceSelected: true,
    sidebarOpen: false,
    sessionsCollapsed: false,
    ...initial,
  };
  const original = {
    'new-session': vi.fn(() => calls.push('open new-session dialog')),
    'search-sessions': vi.fn(() => calls.push('show session search')),
  } satisfies Record<SessionListAction, () => void>;
  let fallback: (() => void)[] | null = null;
  let list: (() => void)[] | null = null;
  const registerAll = (handlerOf: (action: SessionListAction) => () => void) =>
    ACTIONS.map((action) => registerActionHandler(action, handlerOf(action)));
  const unregisterAll = (unregisters: (() => void)[] | null) => {
    for (const unregister of unregisters ?? []) unregister();
  };

  const commit = () => {
    const fallbackOn = sessionListHidden(layout);
    const listMounted = layout.workspaceSelected && layout.sidebarOpen && !layout.sessionsCollapsed;
    if (fallback && !fallbackOn) {
      unregisterAll(fallback);
      fallback = null;
    }
    if (list && !listMounted) {
      unregisterAll(list);
      list = null;
    }
    if (!fallback && fallbackOn) {
      fallback = registerAll((action) => () => revealSessionListThen(action, revealer));
    }
    if (!list && listMounted) list = registerAll((action) => original[action]);
  };
  const revealer = {
    openSidebar: vi.fn(() => {
      calls.push('open sidebar');
      layout.sidebarOpen = true;
    }),
    expandSessions: vi.fn(() => {
      calls.push('expand sessions');
      layout.sessionsCollapsed = false;
      if (options.syncCommit) commit();
    }),
  };

  cleanups.push(() => {
    unregisterAll(fallback);
    unregisterAll(list);
  });
  commit();
  return { calls, layout, original, revealer, commit };
}

describe('左栏收起或会话列表折叠时的「新建会话」「搜索会话」', () => {
  it('新建会话：先展开左栏、再展开会话列表，按钮挂载后才打开弹层（只一次）', () => {
    const ui = setup({ sidebarOpen: false });
    expect(runAction('new-session')).toBe(true);
    expect(ui.calls).toEqual(['open sidebar', 'expand sessions']);
    // 按钮还没挂载：弹层等着
    expect(ui.original['new-session']).not.toHaveBeenCalled();

    ui.commit();
    expect(ui.calls).toEqual(['open sidebar', 'expand sessions', 'open new-session dialog']);
    expect(ui.original['search-sessions']).not.toHaveBeenCalled();

    // 之后由侧栏里的按钮自己处理，不再经过兜底
    expect(runAction('new-session')).toBe(true);
    expect(ui.original['new-session']).toHaveBeenCalledTimes(2);
    expect(ui.revealer.openSidebar).toHaveBeenCalledTimes(1);
  });

  it('搜索会话：先展开，搜索按钮挂载后显示搜索框并聚焦', () => {
    const ui = setup({ sidebarOpen: false, sessionsCollapsed: true });
    expect(runAction('search-sessions')).toBe(true);
    expect(ui.original['search-sessions']).not.toHaveBeenCalled();

    ui.commit();
    expect(ui.calls).toEqual(['open sidebar', 'expand sessions', 'show session search']);
    expect(ui.original['new-session']).not.toHaveBeenCalled();
  });

  it('左栏展开着、只是会话列表折叠：同样先展开再执行', () => {
    const ui = setup({ sidebarOpen: true, sessionsCollapsed: true });
    expect(runAction('new-session')).toBe(true);
    ui.commit();
    expect(ui.layout).toMatchObject({ sidebarOpen: true, sessionsCollapsed: false });
    expect(ui.original['new-session']).toHaveBeenCalledTimes(1);
  });

  it('展开时同步挂载（登记发生在展开的过程里）也不会漏掉', () => {
    const ui = setup({ sidebarOpen: false }, { syncCommit: true });
    expect(runAction('search-sessions')).toBe(true);
    expect(ui.calls).toEqual(['open sidebar', 'expand sessions', 'show session search']);
  });

  it('不按快捷键、只是展开左栏：不会凭空打开弹层或搜索框', () => {
    const ui = setup({ sidebarOpen: false });
    ui.layout.sidebarOpen = true;
    ui.commit();
    expect(ui.original['new-session']).not.toHaveBeenCalled();
    expect(ui.original['search-sessions']).not.toHaveBeenCalled();

    expect(runAction('new-session')).toBe(true);
    expect(ui.original['new-session']).toHaveBeenCalledTimes(1);
    expect(ui.revealer.openSidebar).not.toHaveBeenCalled();
  });

  it('没选中工作区：不登记兜底，按键照旧不拦截', () => {
    const ui = setup({ workspaceSelected: false, sidebarOpen: false });
    expect(runAction('new-session')).toBe(false);
    expect(runAction('search-sessions')).toBe(false);
    expect(ui.revealer.openSidebar).not.toHaveBeenCalled();
  });
});
