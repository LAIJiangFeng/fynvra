import type { IpcResult } from '@shared/types/ipc';
import type {
  MemoryCreateInput,
  MemoryListView,
  MemoryUpdateInput,
  MemoryView,
} from '@shared/types/memory';
import { memoryPreferencesOf, type Preferences } from '@shared/types/settings';
import { type GitRunner, runGit } from '../gitRepository';
import { redactSecrets } from '../secrets';
import { type MemoryDb, type MemoryDbOpenResult, openMemoryDb } from './db';
import { buildIndexText } from './indexText';
import { resolveProjectKey, workspacesSharing } from './projectKey';
import { createMemoryStore, type MemoryStore, MemoryStoreError, toView } from './store';
import {
  createMemoryToolHost,
  type MemoryCaller,
  type MemoryProjectHandle,
  type MemoryToolResult,
} from './toolHost';

// 项目记忆服务入口（ARCHITECTURE §7.15）：给 agentHost（specFor / handle）、IPC（list…clear）与提炼（内部接口）用。

export type { MemoryDb } from './db';
export { buildIndexText } from './indexText';
export { jaccard, rankDocs, tokenize } from './search';
export {
  contentHash,
  MEMORY_PROJECT_LIMIT,
  type MemoryPatch,
  type MemoryRow,
  type MemoryStore,
  MemoryStoreError,
  type NewMemory,
  toView,
} from './store';
export type { MemoryCaller, MemoryProjectHandle, MemoryToolResult } from './toolHost';

/** 过期扫描间隔 */
export const MEMORY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MemoryServiceDeps {
  /** `<userData>/memory/memory.db` */
  dbPath: string;
  now?: () => number;
  runGit?: GitRunner;
  /** 当前设置（按 memoryPreferencesOf 读取 memory 段） */
  preferences: () => Pick<Preferences, 'memory'>;
  /** 工作区 id → 路径与 vcs；不存在返回 undefined */
  workspace: (
    workspaceId: string
  ) =>
    | { path: string; vcs: 'git' | 'none' }
    | undefined
    | Promise<{ path: string; vcs: 'git' | 'none' } | undefined>;
  /** 会话最近的用户消息（pi jsonl 投影），用于 quote 核对 */
  recentUserMessages: (sessionId: string) => Promise<string[]>;
  /** 已知密钥值（生产用 collectAppSecrets）；读取失败时拒绝写入 */
  knownSecrets: () => Promise<string[]>;
  /** 任一写入之后通知受影响的工作区（T6 接到 memory:changed） */
  onChanged?: (workspaceIds: string[]) => void;
}

// shortcut: IPC 错误文案先写死中文，T6 接 IPC 时移进 src/shared/i18n/main
const MESSAGES = {
  unavailable: '记忆库不可用',
  workspace: '工作区不存在',
  'not-found': '记忆不存在',
  duplicate: '已有内容相同的记忆',
  limit: '本项目记忆已达 500 条上限',
  secrets: '无法读取已知密钥，暂不能写入记忆',
} as const;

class SecretsUnavailableError extends Error {}

export type MemoryService = ReturnType<typeof createMemoryService>;

export function createMemoryService(deps: MemoryServiceDeps) {
  const now = deps.now ?? Date.now;
  const git = deps.runGit ?? runGit;
  const prefs = () => memoryPreferencesOf(deps.preferences());

  let opening: Promise<MemoryDbOpenResult> | undefined;
  let store: MemoryStore | undefined;
  /** null = 最近一次读取失败，此时任何写入都拒绝 */
  let known: readonly string[] | null = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  async function database(): Promise<MemoryDb | undefined> {
    opening ??= openMemoryDb(deps.dbPath, now);
    const result = await opening;
    if (!result.ok) return undefined;
    store ??= createMemoryStore(result.db, {
      now,
      redact: (text) => {
        if (known === null) throw new SecretsUnavailableError();
        return redactSecrets(text, known);
      },
    });
    return result.db;
  }

  /** 打开工作区对应的项目，并刷新已知密钥 */
  async function openProject(
    workspaceId: string
  ): Promise<MemoryProjectHandle | { error: string }> {
    const db = await database();
    if (!db || !store) return { error: MESSAGES.unavailable };
    const workspace = await deps.workspace(workspaceId);
    if (!workspace) return { error: MESSAGES.workspace };
    known = await deps.knownSecrets().catch(() => null);
    const projectKey = await resolveProjectKey(
      db,
      { id: workspaceId, ...workspace },
      { runGit: git, now }
    );
    return { store, projectKey };
  }

  function notify(projectKey: string, workspaceId?: string): void {
    if (!store) return;
    const ids = new Set(workspacesSharing(store.db, projectKey));
    if (workspaceId) ids.add(workspaceId);
    if (ids.size > 0) deps.onChanged?.([...ids]);
  }

  function errorText(error: unknown): string {
    if (error instanceof MemoryStoreError) return MESSAGES[error.code];
    if (error instanceof SecretsUnavailableError) return MESSAGES.secrets;
    return error instanceof Error ? error.message : String(error);
  }

  /** IPC 共用：打开项目、执行、出错转成可读文本 */
  async function ipc<T extends object>(
    workspaceId: string,
    fn: (project: MemoryProjectHandle) => T,
    write = true
  ): Promise<IpcResult<T>> {
    try {
      const project = await openProject(workspaceId);
      if ('error' in project) return { ok: false, error: project.error };
      const value = fn(project);
      if (write) notify(project.projectKey, workspaceId);
      return { ok: true, ...value };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  const toolHost = createMemoryToolHost({
    enabled: () => prefs().enabled,
    open: openProject,
    recentUserMessages: deps.recentUserMessages,
    changed: notify,
  });

  async function sweep(): Promise<void> {
    try {
      const preferences = prefs();
      if (!preferences.enabled || !(await database()) || !store) return;
      for (const projectKey of store.sweep(preferences.expireDays)) notify(projectKey);
    } catch (error) {
      console.warn(`[memory] 过期清理失败：${errorText(error)}`);
    }
  }

  return {
    // ---- agentHost（T4）----

    /** 会话要注入的记忆；档位会话、总开关关闭、库不可用时 undefined；worker 没有 active 记忆时也 undefined */
    async specFor(caller: MemoryCaller): Promise<{ index: string; write: boolean } | undefined> {
      if (caller.profile || !prefs().enabled) return undefined;
      try {
        const project = await openProject(caller.workspaceId);
        if ('error' in project) return undefined;
        const active = project.store.byStatus(project.projectKey, 'active');
        const worker = caller.dispatchId !== undefined;
        if (worker && active.length === 0) return undefined;
        return { index: buildIndexText(active), write: !worker };
      } catch (error) {
        console.warn(`[memory] 生成记忆索引失败：${errorText(error)}`);
        return undefined;
      }
    },

    /** host-invoke kind 'memory' 的处理；永不抛错 */
    handle: (
      caller: MemoryCaller,
      method: string,
      input: unknown,
      signal?: AbortSignal
    ): Promise<MemoryToolResult> => toolHost.handle(caller, method, input, signal),

    // ---- IPC（T6）----

    list: (workspaceId: string): Promise<IpcResult<MemoryListView>> =>
      ipc(
        workspaceId,
        ({ store, projectKey }) => ({
          memories: store.all(projectKey).map(toView),
          sharedWithWorkspaceIds: workspacesSharing(store.db, projectKey, workspaceId),
        }),
        false
      ),

    /** 界面新增：记为 user、pinned */
    create: (input: MemoryCreateInput): Promise<IpcResult<{ memory: MemoryView }>> =>
      ipc(input.workspaceId, ({ store, projectKey }) => ({
        memory: toView(
          store.insert(projectKey, {
            category: input.category,
            content: input.content,
            sourceKind: 'user',
            pinned: true,
            sourceWorkspaceId: input.workspaceId,
          })
        ),
      })),

    /** 界面编辑：改内容时重算哈希（冲突报错）；编辑算一次使用 */
    update: (input: MemoryUpdateInput): Promise<IpcResult<{ memory: MemoryView }>> =>
      ipc(input.workspaceId, ({ store, projectKey }) =>
        store.transaction(() => {
          const { id, content, category, pinned, status } = input;
          if (content !== undefined || category !== undefined || pinned !== undefined) {
            store.update(projectKey, id, { content, category, pinned });
          }
          if (status !== undefined) store.setStatus(projectKey, id, status);
          store.markUsed(projectKey, [id]);
          const row = store.get(projectKey, id);
          if (!row) throw new MemoryStoreError('not-found');
          return { memory: toView(row) };
        })
      ),

    remove: (input: { workspaceId: string; id: number }): Promise<IpcResult> =>
      ipc(input.workspaceId, ({ store, projectKey }) => {
        if (!store.remove(projectKey, input.id)) throw new MemoryStoreError('not-found');
        return {};
      }),

    /** 清空工作区所属项目（共用的工作区一并清空） */
    clear: (workspaceId: string): Promise<IpcResult<{ removed: number }>> =>
      ipc(workspaceId, ({ store, projectKey }) => ({ removed: store.clear(projectKey) })),

    // ---- 定时清理 ----

    /** 启动时扫一次过期，之后每 6 小时一次（定时器 unref） */
    start(): void {
      if (timer) return;
      void sweep();
      timer = setInterval(() => void sweep(), MEMORY_SWEEP_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    // ---- 提炼（T5）用的内部接口 ----

    /** 库句柄（extraction_jobs 等表）；不可用时 undefined */
    database,
    /** 打开工作区对应的项目（刷新已知密钥），拿 store 与 projectKey 做候选检索等 */
    openProject,
    /** 在一个事务里对项目应用一组操作，成功后通知 memory:changed；任何异常回滚并照常抛出 */
    async applyInTransaction<T>(
      workspaceId: string,
      fn: (project: MemoryProjectHandle) => T
    ): Promise<T> {
      const project = await openProject(workspaceId);
      if ('error' in project) throw new Error(project.error);
      const result = project.store.transaction(() => fn(project));
      notify(project.projectKey, workspaceId);
      return result;
    },
    /** 立即跑一次过期扫描（测试与手动触发） */
    sweep,
  };
}
