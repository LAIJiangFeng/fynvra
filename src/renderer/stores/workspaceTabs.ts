import {
  MAX_UI_TABS,
  parseWorkspaceUi,
  type SavedWorkspaceTab,
  type WorkspaceUiSnapshot,
  workspaceTabKey,
} from '@shared/types/workspaceUi';
import { create } from 'zustand';
import { translate } from '../i18n';
import { bindDiffTabSelection, diffTabsStoreFor } from './diffTabs';
import { filesStoreFor, hasUnsavedFiles, isFileDirty } from './files';
import {
  captureTerminalTabs,
  forgetWorkspaceTerminals,
  restoreTerminalNextNumber,
  setTerminalInputPaused,
  settleTerminalCloses,
  subscribeTerminalScreens,
  terminalNextNumber,
  useTerminalsStore,
} from './terminals';
import { setWorkspaceTabAdmission } from './workspaceTabPolicy';

interface TabUi {
  order: string[];
  active: string;
  ready: boolean;
  error: string | null;
  warning: string | null;
  sessionId: string | null;
}
export const useWorkspaceTabsStore = create<{ views: Record<string, TabUi>; closing: boolean }>(
  () => ({ views: {}, closing: false })
);
interface WorkspaceRuntime {
  token: string;
  seq: number;
  interaction: number;
  applying: boolean;
  removed: boolean;
  closed: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  hydration?: Promise<void>;
  writing?: Promise<void>;
  unsubscribes: (() => void)[];
}
const runtimes = new Map<string, WorkspaceRuntime>();
let allowUnload = false;
function updateView(id: string, change: Partial<TabUi>) {
  useWorkspaceTabsStore.setState((state) => ({
    views: {
      ...state.views,
      [id]: {
        ...(state.views[id] ?? {
          order: ['chat'],
          active: 'chat',
          ready: false,
          error: null,
          warning: null,
          sessionId: null,
        }),
        ...change,
      },
    },
  }));
}
function liveTabs(id: string): SavedWorkspaceTab[] {
  const files = filesStoreFor(id, window.fynvra.files).getState();
  return [
    { kind: 'chat', id: 'chat' },
    ...files.opened.map((file): SavedWorkspaceTab => {
      const preview = files.previews[file.id];
      return {
        kind: 'file',
        id: file.id,
        mode: preview?.mode ?? 'edit',
        ...(preview?.preview?.kind === 'text' && isFileDirty(preview)
          ? { draft: { text: preview.draft, base: preview.preview } }
          : {}),
      };
    }),
    ...diffTabsStoreFor(id)
      .getState()
      .opened.map((tab): SavedWorkspaceTab => ({ ...tab, kind: 'diff' })),
    ...useTerminalsStore
      .getState()
      .tabs.filter((tab) => tab.workspaceId === id)
      .map(
        (tab): SavedWorkspaceTab => ({ ...tab, kind: 'terminal', screen: '', cols: 80, rows: 24 })
      ),
  ];
}
function activeTab(id: string): string {
  const terminal = useTerminalsStore.getState().selected[id];
  const diff = diffTabsStoreFor(id).getState().selectedId;
  const file = filesStoreFor(id, window.fynvra.files).getState().selectedId;
  return terminal ? `terminal:${terminal}` : diff ? `diff:${diff}` : file ? `file:${file}` : 'chat';
}
function reconcile(id: string) {
  const runtime = runtimes.get(id);
  if (!runtime || runtime.removed || runtime.applying) return;
  const view = useWorkspaceTabsStore.getState().views[id];
  const keys = liveTabs(id).map(workspaceTabKey);
  const order = [...(view?.order ?? []).filter((key) => keys.includes(key))];
  for (const key of keys) if (!order.includes(key)) order.push(key);
  const active = activeTab(id);
  if (active !== view?.active) runtime.interaction++;
  updateView(id, { order, active });
  schedule(id);
}
function schedule(id: string) {
  const runtime = runtimes.get(id);
  if (!runtime || runtime.removed) return;
  if (
    !useWorkspaceTabsStore.getState().views[id]?.ready ||
    runtime.timer ||
    useWorkspaceTabsStore.getState().closing
  )
    return;
  // A leading timer (not a reset-on-every-keystroke debounce) also persists continuous output.
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined;
    void persist(id).catch(() => undefined);
  }, 1500);
}
export function markWorkspaceInteraction(id: string) {
  const runtime = runtimes.get(id);
  if (runtime) runtime.interaction++;
}
export function rememberWorkspaceSession(id: string, sessionId: string | null) {
  updateView(id, { sessionId });
  schedule(id);
}
export function moveWorkspaceTab(id: string, key: string, target: string, after: boolean) {
  const view = useWorkspaceTabsStore.getState().views[id];
  if (!view?.ready || key === target || !view.order.includes(key) || !view.order.includes(target))
    return;
  const order = view.order.filter((item) => item !== key);
  order.splice(order.indexOf(target) + Number(after), 0, key);
  markWorkspaceInteraction(id);
  updateView(id, { order });
  schedule(id);
}
export function selectWorkspaceTab(id: string, key: string) {
  const files = filesStoreFor(id, window.fynvra.files),
    diffs = diffTabsStoreFor(id);
  files.getState().showChat();
  useTerminalsStore.getState().select(id, null);
  if (key.startsWith('file:')) files.setState({ selectedId: key.slice(5) });
  else if (key.startsWith('diff:')) diffs.getState().select(key.slice(5));
  else if (key.startsWith('terminal:')) useTerminalsStore.getState().select(id, key.slice(9));
}
export function ensureWorkspaceTabs(id: string, closed?: ReadonlySet<string>): Promise<void> {
  const existing = runtimes.get(id);
  if (existing?.hydration) return existing.hydration;
  const runtime: WorkspaceRuntime = {
    token: '',
    seq: 0,
    interaction: 0,
    applying: false,
    removed: false,
    closed: new Set(closed),
    unsubscribes: [],
  };
  runtimes.set(id, runtime);
  updateView(id, {});
  const files = filesStoreFor(id, window.fynvra.files),
    diffs = diffTabsStoreFor(id);
  // Coordination belongs to the workspace lifetime, including hidden workspaces.
  runtime.unsubscribes.push(bindDiffTabSelection(id, files, useTerminalsStore));
  runtime.unsubscribes.push(
    files.subscribe((state, previous) => {
      if (!useWorkspaceTabsStore.getState().views[id]?.ready)
        for (const file of previous.opened) {
          if (!state.opened.some((current) => current.id === file.id))
            runtime.closed.add(`file:${file.id}`);
        }
      reconcile(id);
    }),
    diffs.subscribe((state, previous) => {
      if (!useWorkspaceTabsStore.getState().views[id]?.ready)
        for (const tab of previous.opened) {
          if (!state.opened.some((current) => current.id === tab.id))
            runtime.closed.add(`diff:${tab.id}`);
        }
      reconcile(id);
    }),
    useTerminalsStore.subscribe((state, previous) => {
      if (!useWorkspaceTabsStore.getState().views[id]?.ready)
        for (const tab of previous.tabs) {
          if (tab.workspaceId === id && !state.tabs.some((current) => current.id === tab.id))
            runtime.closed.add(`terminal:${tab.id}`);
        }
      if (state.tabs !== previous.tabs || state.selected[id] !== previous.selected[id])
        reconcile(id);
    })
  );
  const interaction = runtime.interaction;
  const restoreSelection = liveTabs(id).length === 1 && activeTab(id) === 'chat';
  runtime.hydration = (async () => {
    try {
      const result = await window.fynvra.workspaceUi.load(id);
      if (runtime.removed) return;
      if (!result.ok) throw new Error(result.error);
      runtime.token = result.token;
      runtime.applying = true;
      const fileLoads: Promise<void>[] = [];
      for (const tab of result.snapshot.tabs) {
        if (runtime.closed.has(workspaceTabKey(tab))) continue;
        if (tab.kind === 'file') fileLoads.push(files.getState().restoreFile(tab));
        else if (
          tab.kind === 'diff' &&
          !diffs.getState().opened.some((item) => item.id === tab.id)
        ) {
          diffs.setState((state) => ({ opened: [...state.opened, { ...tab, workspaceId: id }] }));
        } else if (tab.kind === 'terminal') void useTerminalsStore.getState().create(id, tab);
      }
      restoreTerminalNextNumber(result.snapshot.nextTerminalNumber);
      const keys = liveTabs(id).map(workspaceTabKey);
      const restoredOrder = result.snapshot.tabs
        .map(workspaceTabKey)
        .filter((key) => keys.includes(key));
      updateView(id, {
        order: [...restoredOrder, ...keys.filter((key) => !restoredOrder.includes(key))],
        sessionId:
          useWorkspaceTabsStore.getState().views[id]?.sessionId ?? result.snapshot.sessionId,
      });
      runtime.applying = false;
      // The restored tab entries are visible now. Later file reads only update content.
      if (restoreSelection && runtime.interaction === interaction)
        selectWorkspaceTab(
          id,
          keys.includes(result.snapshot.active) ? result.snapshot.active : 'chat'
        );
      await Promise.all(fileLoads);
      if (runtime.removed) return;
      updateView(id, {
        ready: true,
        warning: result.warning ? translate('workspaceTabs.corrupt') : null,
        error: null,
      });
      runtime.closed.clear();
      reconcile(id);
    } catch (error) {
      runtime.applying = false;
      if (!runtime.removed)
        updateView(id, {
          error: error instanceof Error ? error.message : translate('workspaceTabs.failed'),
        });
    }
  })();
  return runtime.hydration;
}
async function persist(id: string, discard = false): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime || runtime.removed) return;
  await runtime.hydration;
  if (runtime.removed) return;
  if (!useWorkspaceTabsStore.getState().views[id]?.ready)
    throw new Error(translate('workspaceTabs.failed'));
  if (runtime.writing) {
    await runtime.writing;
    return persist(id, discard);
  }
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = undefined;
  }
  const writing = (async () => {
    const screens = await captureTerminalTabs(id);
    if (runtime.removed) return;
    // Read metadata AFTER the asynchronous capture, so closed tabs cannot reappear.
    const view = useWorkspaceTabsStore.getState().views[id];
    const tabs = liveTabs(id).map((tab) => {
      if (tab.kind === 'terminal') return screens.find((screen) => screen.id === tab.id) ?? tab;
      if (tab.kind === 'file' && discard) {
        const { draft: _draft, ...rest } = tab;
        return rest;
      }
      return tab;
    });
    const ordered = view.order.flatMap((key) => {
      const tab = tabs.find((item) => workspaceTabKey(item) === key);
      return tab ? [tab] : [];
    });
    const snapshot: WorkspaceUiSnapshot = {
      version: 1,
      tabs: ordered,
      active: view.active,
      sessionId: view.sessionId,
      nextTerminalNumber: terminalNextNumber(),
    };
    if (!parseWorkspaceUi(snapshot, id)) throw new Error(translate('workspaceTabs.limits'));
    const result = await window.fynvra.workspaceUi.save({
      workspaceId: id,
      token: runtime.token,
      seq: ++runtime.seq,
      snapshot,
    });
    if (!result.ok) throw new Error(result.error);
    if (!runtime.removed) updateView(id, { error: null });
  })();
  runtime.writing = writing;
  try {
    await writing;
  } catch (error) {
    if (!runtime.removed)
      updateView(id, {
        error: error instanceof Error ? error.message : translate('workspaceTabs.failed'),
      });
    throw error;
  } finally {
    if (runtime.writing === writing) runtime.writing = undefined;
  }
}
export async function retryWorkspaceTabs(id: string): Promise<void> {
  updateView(id, { warning: null });
  if (useWorkspaceTabsStore.getState().views[id]?.ready) {
    await persist(id).catch(() => undefined);
    return;
  }
  const runtime = runtimes.get(id);
  if (runtime) {
    runtime.removed = true;
    if (runtime.timer) clearTimeout(runtime.timer);
    for (const unsubscribe of runtime.unsubscribes) unsubscribe();
    runtimes.delete(id);
  }
  await ensureWorkspaceTabs(id, runtime?.closed);
}

export function workspaceTabLimitReached(id: string): boolean {
  if (liveTabs(id).length < MAX_UI_TABS) return false;
  updateView(id, { error: translate('workspaceTabs.limits') });
  return true;
}
setWorkspaceTabAdmission((id) => !workspaceTabLimitReached(id));

export function forgetWorkspaceTabs(id: string) {
  const runtime = runtimes.get(id);
  if (runtime) {
    runtime.removed = true;
    if (runtime.timer) clearTimeout(runtime.timer);
    for (const unsubscribe of runtime.unsubscribes) unsubscribe();
  }
  forgetWorkspaceTerminals(id);
  const files = filesStoreFor(id, window.fynvra.files);
  for (const file of files.getState().opened) files.getState().closeFile(file.id, true);
  diffTabsStoreFor(id).setState({ opened: [], selectedId: null });
  runtimes.delete(id);
  useWorkspaceTabsStore.setState((state) => {
    const views = { ...state.views };
    delete views[id];
    return { views };
  });
}
export function bindWorkspaceUiLifecycle(): () => void {
  let flushGeneration = 0;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!allowUnload) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const unlisten = subscribeTerminalScreens((id) => schedule(id));
  const unflush = window.fynvra.workspaceUi.onFlush((request) => {
    const generation = ++flushGeneration;
    if (request.mode === 'resume') {
      allowUnload = false;
      setTerminalInputPaused(false);
      useWorkspaceTabsStore.setState({ closing: false });
      for (const id of runtimes.keys()) schedule(id);
      return;
    }
    void (async () => {
      let ok = false;
      useWorkspaceTabsStore.setState({ closing: true });
      setTerminalInputPaused(true);
      for (const runtime of runtimes.values()) {
        if (runtime.timer) {
          clearTimeout(runtime.timer);
          runtime.timer = undefined;
        }
      }
      try {
        await settleTerminalCloses();
        // Saves in progress must finish before deciding which drafts remain dirty.
        for (const [id, runtime] of runtimes) {
          await runtime.hydration;
          const files = filesStoreFor(id, window.fynvra.files);
          if (Object.values(files.getState().previews).some((preview) => preview.saving)) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error('save timeout'));
              }, 20_000);
              const unsubscribe = files.subscribe((state) => {
                if (!Object.values(state.previews).some((preview) => preview.saving)) {
                  clearTimeout(timer);
                  unsubscribe();
                  resolve();
                }
              });
            });
          }
        }
        if (request.mode !== 'check')
          await Promise.all(
            [...runtimes.keys()].map((id) => persist(id, request.mode === 'discard'))
          );
        if (generation !== flushGeneration) throw new Error('expired flush');
        if (request.mode === 'discard')
          for (const id of runtimes.keys())
            filesStoreFor(id, window.fynvra.files).getState().discardDrafts();
        ok = true;
        if (request.mode !== 'check') allowUnload = true;
      } catch {
        /* Main keeps the window alive and reports the failure. */
      }
      const accepted = await window.fynvra.workspaceUi.flushed({
        requestId: request.requestId,
        ok,
        dirty: hasUnsavedFiles(),
      });
      if (!accepted.ok && generation === flushGeneration) allowUnload = false;
      if (!allowUnload && generation === flushGeneration) {
        setTerminalInputPaused(false);
        useWorkspaceTabsStore.setState({ closing: false });
        for (const id of runtimes.keys()) schedule(id);
      }
    })();
  });
  return () => {
    flushGeneration++;
    allowUnload = false;
    setTerminalInputPaused(false);
    useWorkspaceTabsStore.setState({ closing: false });
    for (const id of runtimes.keys()) schedule(id);
    window.removeEventListener('beforeunload', beforeUnload);
    unlisten();
    unflush();
  };
}
