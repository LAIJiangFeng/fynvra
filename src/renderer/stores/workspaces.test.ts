/// <reference types="vite/client" />
import type { WorkspaceSummary } from '@shared/types/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacesApi } from '../../preload/domains/workspaces';

const workspace = (id: string): WorkspaceSummary => ({
  id,
  name: id,
  displayPath: `/${id}`,
  vcs: 'git',
});

async function setup() {
  let workspaces = ['a', 'b', 'c'].map(workspace);
  const api = {
    list: vi.fn(async () => ({ ok: true as const, workspaces })),
    add: vi.fn(async () => {
      const added = workspace('new');
      workspaces = [...workspaces, added];
      return { ok: true as const, workspace: added, created: true };
    }),
    remove: vi.fn(async (id: string) => {
      workspaces = workspaces.filter((item) => item.id !== id);
      return { ok: true as const };
    }),
    onChanged: vi.fn(() => () => {}),
  } satisfies Pick<WorkspacesApi, 'list' | 'add' | 'remove' | 'onChanged'>;
  vi.stubGlobal('window', {
    fynvra: {
      workspaces: api,
      notifications: { onFocusSession: vi.fn(), setViewing: vi.fn() },
    },
  });
  const { useWorkspacesStore: store } = await import('./workspaces');
  await store.getState().refresh();
  return { store, api };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('工作区独立展开', () => {
  it('展开非当前项目不改变选中，切换与折叠只影响指定项目', async () => {
    const { store } = await setup();
    store.getState().select('a');
    store.getState().toggleSessions('b');
    store.getState().toggleSessions('c');
    expect(store.getState().selectedId).toBe('a');
    expect(store.getState().expandedWorkspaces).toEqual({ a: true, b: true, c: true });

    store.getState().select('b');
    store.getState().toggleSessions('a');
    expect(store.getState().expandedWorkspaces).toEqual({ a: false, b: true, c: true });
    store.getState().select('c');
    expect(store.getState().expandedWorkspaces).toEqual({ a: false, b: true, c: true });
    // 点击项目行会选择并打开它；再次选择不会折叠
    store.getState().select('a');
    store.getState().select('a');
    expect(store.getState().expandedWorkspaces).toEqual({ a: true, b: true, c: true });
  });

  it('会话入口同步侧栏、聊天与文件视图，延后挂载同步也不清掉新选择', async () => {
    const { store } = await setup();
    const { useSessionsStore: sessions, connectSessionsWorkspace } = await import('./sessions');
    const { filesStoreFor } = await import('./files');
    store.getState().select('a');
    const inB = await sessions.getState().createSession('worker', undefined, 'b');
    expect(inB.ok).toBe(true);
    if (!inB.ok) return;
    // 先选中跨项目会话，App 的 effect 随后才挂载：同步必须读取最新 b
    const disconnect = connectSessionsWorkspace();
    try {
      expect(store.getState().selectedId).toBe('b');
      expect(sessions.getState()).toMatchObject({
        workspaceId: 'b',
        activeSessionId: inB.session.id,
      });
      store.getState().select('a');
      expect(sessions.getState()).toMatchObject({ workspaceId: 'a', activeSessionId: null });
      filesStoreFor('b', undefined).setState({ selectedId: 'file-in-b' });
      filesStoreFor('a', undefined).setState({ selectedId: 'file-in-a' });
      const selecting = sessions.getState().selectSession(inB.session.id);
      // 在 history 回包前就已切好所有视图
      expect(store.getState().selectedId).toBe('b');
      expect(sessions.getState()).toMatchObject({
        workspaceId: 'b',
        activeSessionId: inB.session.id,
      });
      expect(filesStoreFor('b', undefined).getState().selectedId).toBeNull();
      expect(filesStoreFor('a', undefined).getState().selectedId).toBe('file-in-a');
      await selecting;
      store.getState().toggleSessions('a');
      expect(sessions.getState().activeSessionId).toBe(inB.session.id);
      expect(store.getState().expandedWorkspaces).toEqual({ a: false, b: true });
    } finally {
      disconnect();
    }
  });

  it('快捷键展开当前项目时保留其他项目的展开偏好', async () => {
    const { store } = await setup();
    store.getState().select('a');
    store.getState().toggleSessions('a');
    store.getState().toggleSessions('b');
    store.getState().expandSessions();
    expect(store.getState().selectedId).toBe('a');
    expect(store.getState().expandedWorkspaces).toEqual({ a: true, b: true });
  });

  it('新挂入的项目展开，刷新保留偏好，移除清理展开记录', async () => {
    const { store } = await setup();
    store.getState().select('a');
    store.getState().toggleSessions('b');
    await store.getState().add();
    expect(store.getState().selectedId).toBe('new');
    expect(store.getState().expandedWorkspaces).toEqual({ a: true, b: true, new: true });
    store.getState().toggleSessions('a');
    await store.getState().refresh();
    expect(store.getState().expandedWorkspaces).toEqual({ a: false, b: true, new: true });
    await store.getState().remove('a');
    expect(store.getState().expandedWorkspaces).toEqual({ b: true, new: true });
    await store.getState().remove('new');
    expect(store.getState().expandedWorkspaces).toEqual({ b: true });
    expect(store.getState().selectedId).toBeNull();
  });
});
