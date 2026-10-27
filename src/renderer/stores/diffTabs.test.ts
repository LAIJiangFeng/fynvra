import type { WorkspaceFileEntry } from '@shared/types/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createFilesApi } from '../../preload/domains/files';
import { bindDiffTabSelection, createDiffTabsStore, diffTabId, diffTabsStoreFor } from './diffTabs';
import { createFilesStore, isFileDirty } from './files';

const tab = {
  dispatchId: 'dispatch-a',
  section: 'committed' as const,
  path: 'src/a.ts',
  status: 'modified' as const,
};
const file: WorkspaceFileEntry = {
  id: 'file-a',
  name: 'a.ts',
  relativePath: 'src/a.ts',
  kind: 'file',
};
const readResult = {
  ok: true,
  preview: { kind: 'text', text: 'original', size: 8, version: 'a'.repeat(64) },
};

describe('diff tabs', () => {
  it('focuses one tab when opening the same path again and updates its metadata', () => {
    const store = createDiffTabsStore('workspace');
    store.getState().open(tab);
    store.getState().open({ ...tab, path: 'src/b.ts' });
    store.getState().open({ ...tab, oldPath: 'src/old.ts', status: 'renamed' });

    expect(store.getState().opened).toHaveLength(2);
    expect(store.getState().selectedId).toBe(diffTabId(tab));
    expect(store.getState().opened[0]).toEqual({
      ...tab,
      id: diffTabId(tab),
      workspaceId: 'workspace',
      oldPath: 'src/old.ts',
      status: 'renamed',
    });
  });

  it('keeps sections and dispatches distinct even when paths match', () => {
    const store = createDiffTabsStore('workspace');
    const uncommitted = { ...tab, section: 'uncommitted' as const };
    const otherDispatch = { ...tab, dispatchId: 'dispatch-b' };
    for (const input of [tab, uncommitted, otherDispatch]) store.getState().open(input);
    expect(store.getState().opened.map((item) => item.id)).toEqual(
      [tab, uncommitted, otherDispatch].map(diffTabId)
    );
  });

  it('selects, ignores unknown ids, and closes tabs without stealing focus', () => {
    const store = createDiffTabsStore('workspace');
    const second = { ...tab, path: 'src/b.ts' };
    const third = { ...tab, path: 'src/c.ts' };
    for (const input of [tab, second, third]) store.getState().open(input);

    store.getState().select(diffTabId(tab));
    store.getState().select('unknown');
    store.getState().close(diffTabId(third));
    expect(store.getState().selectedId).toBe(diffTabId(tab));
    store.getState().close(diffTabId(tab));
    expect(store.getState().selectedId).toBe(diffTabId(second));
    store.getState().select(null);
    expect(store.getState().opened).toHaveLength(1);
    expect(store.getState().selectedId).toBeNull();
    store.getState().select(diffTabId(second));
    store.getState().close(diffTabId(second));
    store.getState().close('unknown');
    expect(store.getState().opened).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
  });

  it('retains separate tab lists and selections for each workspace', () => {
    const first = diffTabsStoreFor('isolation-a');
    const second = diffTabsStoreFor('isolation-b');
    first.getState().open(tab);
    expect(diffTabsStoreFor('isolation-a')).toBe(first);
    expect(second.getState().opened).toEqual([]);
    second.getState().open(tab);
    first.getState().close(diffTabId(tab));
    expect(second.getState().selectedId).toBe(diffTabId(tab));
    expect(second.getState().opened[0]?.workspaceId).toBe('isolation-b');
  });
});

const unbind: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of unbind.splice(0)) cleanup();
});
let nextWorkspace = 0;
function selectionStores(invoke = vi.fn(async (): Promise<unknown> => readResult)) {
  const workspaceId = `selection-${nextWorkspace++}`;
  const files = createFilesStore(createFilesApi({ invoke }), workspaceId);
  const diffs = diffTabsStoreFor(workspaceId);
  const terminals = createStore<{
    selected: Record<string, string | null>;
    select(workspaceId: string, id: string | null): void;
  }>()((set) => ({
    selected: {},
    select: (id, tabId) => set((state) => ({ selected: { ...state.selected, [id]: tabId } })),
  }));
  unbind.push(bindDiffTabSelection(workspaceId, files, terminals));
  return { workspaceId, files, diffs, terminals };
}

describe('center tab selection', () => {
  it('makes file, terminal and diff selection mutually exclusive in both directions', async () => {
    const { workspaceId, files, diffs, terminals } = selectionStores();
    const selected = () => [
      files.getState().selectedId,
      terminals.getState().selected[workspaceId] ?? null,
      diffs.getState().selectedId,
    ];
    await files.getState().openFile(file);
    expect(selected()).toEqual([file.id, null, null]);
    diffs.getState().open(tab);
    expect(selected()).toEqual([null, null, diffTabId(tab)]);
    terminals.getState().select(workspaceId, 'terminal');
    expect(selected()).toEqual([null, 'terminal', null]);
    diffs.getState().select(diffTabId(tab));
    expect(selected()).toEqual([null, null, diffTabId(tab)]);
    await files.getState().openFile(file);
    expect(selected()).toEqual([file.id, null, null]);
    terminals.getState().select(workspaceId, 'terminal');
    expect(selected()).toEqual([null, 'terminal', null]);
    await files.getState().openFile(file);
    expect(selected()).toEqual([file.id, null, null]);
  });

  it('returns to chat through showChat, including when no file was selected', () => {
    const { files, diffs } = selectionStores();
    diffs.getState().open(tab);
    expect(files.getState().selectedId).toBeNull();
    // 会话列表和会话切换也使用 showChat。
    files.getState().showChat();
    expect(diffs.getState().selectedId).toBeNull();
    expect(diffs.getState().opened).toHaveLength(1);
    diffs.getState().select(diffTabId(tab));
    diffs.getState().close(diffTabId(tab));
    expect(files.getState().selectedId).toBeNull();
    expect(diffs.getState().selectedId).toBeNull();
  });

  it('keeps dirty files and their close protection while a diff is selected', async () => {
    const { files, diffs } = selectionStores();
    await files.getState().openFile(file);
    files.getState().editFile(file.id, 'draft');
    diffs.getState().open(tab);
    expect(isFileDirty(files.getState().previews[file.id])).toBe(true);
    expect(files.getState().closeFile(file.id)).toBe(false);
    expect(diffs.getState().selectedId).toBe(diffTabId(tab));
    expect(files.getState().previews[file.id]?.draft).toBe('draft');
    expect(files.getState().closeFile(file.id, true)).toBe(true);
    expect(diffs.getState().selectedId).toBe(diffTabId(tab));
  });

  it('does not let background file reads or another workspace steal diff focus', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        })
    );
    const { workspaceId, files, diffs, terminals } = selectionStores(invoke);
    const reading = files.getState().openFile(file);
    diffs.getState().open(tab);
    terminals.getState().select('other-workspace', 'terminal');
    resolve(readResult);
    await reading;
    expect(files.getState().selectedId).toBeNull();
    expect(terminals.getState().selected[workspaceId]).toBeNull();
    expect(diffs.getState().selectedId).toBe(diffTabId(tab));
    expect(files.getState().previews[file.id]?.preview).toEqual(readResult.preview);
  });
});
