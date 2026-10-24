import type { Dispatch, Message, Run, Task, TaskStatus } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { create } from 'zustand';
import {
  getOrchestrationApi,
  type OrchestrationApi,
  type OrchestrationSnapshotView,
  type ReviewDiffView,
  type WorkerOutputPage,
} from '../lib/api/orchestration';

/** worker 输出在读到末尾、worker 仍在运行时的轮询间隔。 */
export const OUTPUT_POLL_MS = 1_500;
/** 每次尝试的输出最多保留的字符数；更早的部分丢弃，只记丢了多少。 */
export const MAX_OUTPUT_CHARS = 1_000_000;
/** 小页合并到上一页，页数随输出长度而不是轮询次数增长。 */
const PAGE_MERGE_CHARS = 8_192;

export interface SnapshotEntry {
  /** 最近一次成功拉到的快照；首次加载完成前为 null */
  view: OrchestrationSnapshotView | null;
  loading: boolean;
  /** 最近一次拉取失败的原因；失败时保留上一份快照 */
  error: string | null;
}

export interface OutputEntry {
  /** 已缓存的输出，按 cursor 顺序分页 */
  pages: string[];
  /** 下一次 readWorkerOutput 的 cursor（字符偏移，含已丢弃部分） */
  cursor: number;
  /** Main 报告的输出总长度 */
  total: number;
  /** 超过保留上限后丢掉的最早字符数 */
  dropped: number;
  /** worker 已结束且已读到末尾：不再轮询 */
  done: boolean;
  /** 读取失败的原因；失败后停止轮询，等 retryOutput */
  error: string | null;
}

export type ReviewDiffData = Omit<ReviewDiffView, 'ok'>;

export type DiffEntry =
  | { status: 'loading' }
  | { status: 'ready'; data: ReviewDiffData; refreshing: boolean }
  | { status: 'error'; error: string };

export interface OrchestrationState {
  /** 按 workspace 缓存的快照 */
  snapshots: Record<string, SnapshotEntry>;
  /** 按 dispatch 缓存的 worker 输出 */
  outputs: Record<string, OutputEntry>;
  /** 按 dispatch 缓存的 reviewDiff 结果 */
  diffs: Record<string, DiffEntry>;
  /** 进入视图：（重新）拉取快照，之后 Main 推送该工作区变化时自动重拉。返回退出函数 */
  watchWorkspace(workspaceId: string): () => void;
  refresh(workspaceId: string): Promise<void>;
  /** 打开一次尝试的输出：按 cursor 分页读取，未结束时每 1.5s 轮询。返回退出函数（引用计数） */
  watchOutput(dispatchId: string): () => void;
  /** 读取失败后重新开始 */
  retryOutput(dispatchId: string): void;
  /** 读取改动；已缓存时不重复请求，`force` 重新读取 */
  loadDiff(dispatchId: string, options?: { force?: boolean }): Promise<void>;
}

const EMPTY_SNAPSHOT: SnapshotEntry = { view: null, loading: false, error: null };
const EMPTY_OUTPUT: OutputEntry = {
  pages: [],
  cursor: 0,
  total: 0,
  dropped: 0,
  done: false,
  error: null,
};

interface OutputRuntime {
  watchers: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
}

/** IPC 调用本身失败（极少见）也折成 { ok: false }，后面只处理一种形状。 */
async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 编排面板 store。不读全局 window，便于在 node 下测试；应用内实例见 {@link useOrchestrationStore}。
 */
export function createOrchestrationStore(
  api: OrchestrationApi,
  options: { pollMs?: number; maxOutputChars?: number } = {}
) {
  const pollMs = options.pollMs ?? OUTPUT_POLL_MS;
  const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;

  const workspaceWatchers = new Map<string, number>();
  const snapshotRuns = new Map<string, Promise<void>>();
  const snapshotAgain = new Set<string>();
  const outputRuntimes = new Map<string, OutputRuntime>();
  const diffRuns = new Map<string, Promise<void>>();
  let subscribed = false;

  return create<OrchestrationState>()((set, get) => {
    const patchSnapshot = (workspaceId: string, patch: Partial<SnapshotEntry>) =>
      set((state) => ({
        snapshots: {
          ...state.snapshots,
          [workspaceId]: { ...(state.snapshots[workspaceId] ?? EMPTY_SNAPSHOT), ...patch },
        },
      }));

    const setOutput = (dispatchId: string, entry: OutputEntry) =>
      set((state) => ({ outputs: { ...state.outputs, [dispatchId]: entry } }));

    const setDiff = (dispatchId: string, entry: DiffEntry) =>
      set((state) => ({ diffs: { ...state.diffs, [dispatchId]: entry } }));

    async function fetchSnapshot(workspaceId: string): Promise<void> {
      patchSnapshot(workspaceId, { loading: true });
      const result = await safely(() => api.snapshot(workspaceId));
      if (!result.ok) {
        patchSnapshot(workspaceId, { loading: false, error: result.error });
        return;
      }
      const { ok: _ok, ...next } = result;
      const previous = get().snapshots[workspaceId]?.view ?? null;
      const merged = mergeSnapshot(previous, next);
      patchSnapshot(workspaceId, { view: merged, loading: false, error: null });
      if (previous !== null && merged !== previous) recheckFinishedOutputs();
    }

    /** 同一工作区同时只有一个请求；请求期间又有变化，就在它结束后再拉一次。 */
    function refresh(workspaceId: string): Promise<void> {
      const running = snapshotRuns.get(workspaceId);
      if (running) {
        snapshotAgain.add(workspaceId);
        return running;
      }
      const run = (async () => {
        do {
          snapshotAgain.delete(workspaceId);
          await fetchSnapshot(workspaceId);
        } while (snapshotAgain.has(workspaceId));
      })().finally(() => snapshotRuns.delete(workspaceId));
      snapshotRuns.set(workspaceId, run);
      return run;
    }

    /**
     * 读一页并决定下一步：`now` 还有没读到的（Host 截断了这一页）、`later` 读到末尾但 worker 仍在跑、
     * `stop` 已结束或出错。
     */
    async function fetchOutput(dispatchId: string): Promise<'now' | 'later' | 'stop'> {
      const entry = get().outputs[dispatchId] ?? EMPTY_OUTPUT;
      const result = await safely(() => api.readWorkerOutput({ dispatchId, cursor: entry.cursor }));
      if (!result.ok) {
        setOutput(dispatchId, { ...entry, error: result.error });
        return 'stop';
      }
      if (result.total < entry.cursor) {
        // 输出变短：Main 重启后按 jsonl 重建了投影，旧 cursor 失效，从头再读
        setOutput(dispatchId, EMPTY_OUTPUT);
        return 'now';
      }
      const next = appendOutputPage(entry, result, maxOutputChars);
      setOutput(dispatchId, next);
      if (next.cursor < next.total && result.text.length > 0) return 'now';
      return next.done ? 'stop' : 'later';
    }

    function pump(dispatchId: string, force = false): void {
      const runtime = outputRuntimes.get(dispatchId);
      if (!runtime || runtime.watchers === 0 || runtime.inflight) return;
      const entry = get().outputs[dispatchId] ?? EMPTY_OUTPUT;
      if (!force && (entry.done || entry.error !== null)) return;
      if (runtime.timer !== null) {
        clearTimeout(runtime.timer);
        runtime.timer = null;
      }
      runtime.inflight = true;
      void fetchOutput(dispatchId).then((next) => {
        runtime.inflight = false;
        if (runtime.watchers === 0) return;
        if (next === 'now') {
          pump(dispatchId);
        } else if (next === 'later') {
          runtime.timer = setTimeout(() => {
            runtime.timer = null;
            pump(dispatchId);
          }, pollMs);
        }
      });
    }

    /** 快照变了（如 send_to_worker 之后）：已结束的输出再看一眼，worker 可能在同一次尝试里继续产出。 */
    function recheckFinishedOutputs(): void {
      for (const [dispatchId, runtime] of outputRuntimes) {
        if (runtime.watchers === 0 || runtime.inflight || runtime.timer !== null) continue;
        if (get().outputs[dispatchId]?.done) pump(dispatchId, true);
      }
    }

    return {
      snapshots: {},
      outputs: {},
      diffs: {},

      watchWorkspace(workspaceId) {
        // 第一次进入视图时订阅；store 与窗口同寿命，不退订
        if (!subscribed) {
          subscribed = true;
          api.onChanged((changed) => {
            if ((workspaceWatchers.get(changed) ?? 0) > 0) void refresh(changed);
          });
        }
        workspaceWatchers.set(workspaceId, (workspaceWatchers.get(workspaceId) ?? 0) + 1);
        void refresh(workspaceId);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const left = (workspaceWatchers.get(workspaceId) ?? 1) - 1;
          if (left > 0) workspaceWatchers.set(workspaceId, left);
          else workspaceWatchers.delete(workspaceId);
        };
      },

      refresh,

      watchOutput(dispatchId) {
        let runtime = outputRuntimes.get(dispatchId);
        if (!runtime) {
          runtime = { watchers: 0, timer: null, inflight: false };
          outputRuntimes.set(dispatchId, runtime);
        }
        const current = runtime;
        current.watchers += 1;
        if (current.watchers === 1) {
          const entry = get().outputs[dispatchId];
          if (entry?.error) setOutput(dispatchId, { ...entry, error: null });
          // 重新打开时总要读一次：关闭期间 worker 可能又有输出
          pump(dispatchId, true);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          current.watchers -= 1;
          if (current.watchers === 0 && current.timer !== null) {
            clearTimeout(current.timer);
            current.timer = null;
          }
        };
      },

      retryOutput(dispatchId) {
        const entry = get().outputs[dispatchId];
        if (entry?.error) setOutput(dispatchId, { ...entry, error: null });
        pump(dispatchId, true);
      },

      loadDiff(dispatchId, { force = false } = {}) {
        const running = diffRuns.get(dispatchId);
        if (running) return running;
        const current = get().diffs[dispatchId];
        if (current?.status === 'ready' && !force) return Promise.resolve();
        setDiff(
          dispatchId,
          current?.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' }
        );
        const run = (async () => {
          const result = await safely(() => api.reviewDiff(dispatchId));
          if (result.ok) {
            const { ok: _ok, ...data } = result;
            setDiff(dispatchId, { status: 'ready', data, refreshing: false });
          } else {
            setDiff(dispatchId, { status: 'error', error: result.error });
          }
        })().finally(() => diffRuns.delete(dispatchId));
        diffRuns.set(dispatchId, run);
        return run;
      },
    };
  });
}

/** 把一页输出接到缓存后面：cursor 按返回文本的长度递进，超过保留上限时丢掉最早的部分。 */
export function appendOutputPage(
  entry: OutputEntry,
  page: Omit<WorkerOutputPage, 'ok'>,
  maxChars: number = MAX_OUTPUT_CHARS
): OutputEntry {
  let pages = entry.pages;
  if (page.text !== '') {
    const last = pages.at(-1);
    pages =
      last !== undefined && last.length + page.text.length <= PAGE_MERGE_CHARS
        ? [...pages.slice(0, -1), last + page.text]
        : [...pages, page.text];
  }
  const cursor = entry.cursor + page.text.length;
  let dropped = entry.dropped;
  let kept = cursor - dropped;
  while (kept > maxChars && pages.length > 0) {
    const first = pages[0] ?? '';
    const excess = kept - maxChars;
    if (first.length > excess && pages.length === 1) {
      pages = [first.slice(excess)];
      dropped += excess;
      kept -= excess;
    } else {
      pages = pages.slice(1);
      dropped += first.length;
      kept -= first.length;
    }
  }
  return {
    pages,
    cursor,
    total: page.total,
    dropped,
    done: page.done && cursor >= page.total,
    error: null,
  };
}

// --- 快照归并 ------------------------------------------------------------------------------

/**
 * 新快照归并进旧快照：内容没变的记录与集合沿用旧引用，整份都没变时返回旧快照本身。
 * 按字段订阅的组件和基于引用缓存的选择器因此只在真正变化时更新。
 */
export function mergeSnapshot(
  previous: OrchestrationSnapshotView | null,
  next: OrchestrationSnapshotView
): OrchestrationSnapshotView {
  if (previous === null) return next;
  const merged: OrchestrationSnapshotView = {
    runs: reuseRecords(previous.runs, next.runs),
    tasks: reuseRecords(previous.tasks, next.tasks),
    dispatches: reuseRecords(previous.dispatches, next.dispatches),
    worktrees: reuseRecords(previous.worktrees, next.worktrees),
    messages: reuseRecords(previous.messages, next.messages),
  };
  const unchanged = (Object.keys(merged) as Array<keyof OrchestrationSnapshotView>).every(
    (key) => merged[key] === previous[key]
  );
  return unchanged ? previous : merged;
}

function reuseRecords<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map((record) => [record.id, record]));
  let changed = previous.length !== next.length;
  const merged = next.map((record, index) => {
    const old = byId.get(record.id);
    const kept = old !== undefined && sameJson(old, record) ? old : record;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

// --- 派生选择器 ----------------------------------------------------------------------------
// 结果按输入集合的引用缓存：同一份快照反复调用拿到同一个对象，可以直接在 store 选择器里用。

export type TaskGroups = Record<TaskStatus, Task[]>;

const NO_DISPATCHES: Dispatch[] = [];
const NO_MESSAGES: Message[] = [];
const EMPTY_GROUPS: TaskGroups = emptyGroups();

function emptyGroups(): TaskGroups {
  return {
    todo: [],
    'in-progress': [],
    'in-review': [],
    completed: [],
    failed: [],
    abandoned: [],
  };
}

const groupsCache = new WeakMap<Task[], Map<string, TaskGroups>>();
const dispatchIndexCache = new WeakMap<Dispatch[], Map<string, Dispatch[]>>();
const messageIndexCache = new WeakMap<Message[], Map<string, Message[]>>();

/** 某个 Run 的任务按状态分组；组内保持快照顺序（即派发顺序）。 */
export function tasksByStatus(
  view: OrchestrationSnapshotView | null,
  runId: string | null
): TaskGroups {
  if (view === null || runId === null) return EMPTY_GROUPS;
  let byRun = groupsCache.get(view.tasks);
  if (!byRun) {
    byRun = new Map();
    groupsCache.set(view.tasks, byRun);
  }
  const cached = byRun.get(runId);
  if (cached) return cached;
  const groups = emptyGroups();
  for (const task of view.tasks) {
    if (task.runId === runId) groups[task.status].push(task);
  }
  byRun.set(runId, groups);
  return groups;
}

/** 一个任务的全部尝试，按开始时间排序。 */
export function dispatchesOf(view: OrchestrationSnapshotView | null, taskId: string): Dispatch[] {
  if (view === null) return NO_DISPATCHES;
  let index = dispatchIndexCache.get(view.dispatches);
  if (!index) {
    index = groupBy(
      view.dispatches,
      (dispatch) => dispatch.taskId,
      (dispatch) => dispatch.startedAt
    );
    dispatchIndexCache.set(view.dispatches, index);
  }
  return index.get(taskId) ?? NO_DISPATCHES;
}

/** 进行中的尝试（未结算，与 core `OrchestrationStore.activeDispatch` 同义）；都已结算时为 undefined。 */
export function activeDispatchOf(
  view: OrchestrationSnapshotView | null,
  taskId: string
): Dispatch | undefined {
  return dispatchesOf(view, taskId).findLast((dispatch) => dispatch.settledAt === undefined);
}

/** 当前尝试：进行中的那次；没有就是最近一次（与 Main 编排宿主的 latestDispatch 同义）。 */
export function latestDispatchOf(
  view: OrchestrationSnapshotView | null,
  taskId: string
): Dispatch | undefined {
  return activeDispatchOf(view, taskId) ?? dispatchesOf(view, taskId).at(-1);
}

/** 一次尝试的收件箱消息，按时间排序。 */
export function messagesOf(view: OrchestrationSnapshotView | null, dispatchId: string): Message[] {
  if (view === null) return NO_MESSAGES;
  let index = messageIndexCache.get(view.messages);
  if (!index) {
    index = groupBy(
      view.messages.filter((message) => message.dispatchId !== undefined),
      (message) => message.dispatchId ?? '',
      (message) => message.createdAt
    );
    messageIndexCache.set(view.messages, index);
  }
  return index.get(dispatchId) ?? NO_MESSAGES;
}

/** 任务所有尝试里最新的一条消息（卡片上的摘要）。 */
export function latestMessageOfTask(
  view: OrchestrationSnapshotView | null,
  taskId: string
): Message | undefined {
  let latest: Message | undefined;
  for (const dispatch of dispatchesOf(view, taskId)) {
    const last = messagesOf(view, dispatch.id).at(-1);
    if (last && (latest === undefined || last.createdAt >= latest.createdAt)) latest = last;
  }
  return latest;
}

/** 工作区的 Run，最新的在前。 */
export function runsOf(view: OrchestrationSnapshotView | null): Run[] {
  if (view === null) return [];
  return [...view.runs].sort((a, b) => b.createdAt - a.createdAt);
}

function groupBy<T extends { id: string }>(
  records: readonly T[],
  key: (record: T) => string,
  time: (record: T) => number
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const record of records) {
    const bucket = index.get(key(record));
    if (bucket) bucket.push(record);
    else index.set(key(record), [record]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  }
  return index;
}

/** 应用内实例：数据源见 {@link getOrchestrationApi}（preload 或内存 mock）。 */
export const useOrchestrationStore = createOrchestrationStore(getOrchestrationApi());
