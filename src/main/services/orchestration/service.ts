import type {
  HostResult,
  OrchestrationHost,
  ReadWorkerOutputOutput,
  ReviewDiffOutput,
  WorkerHost,
} from '@fynvra/agent-runtime';
import {
  type CoreFs,
  type Dispatch,
  type EntityTable,
  type ExecFn,
  GitWorktreeManager,
  Inbox,
  InMemoryOrchestrationStore,
  isDispatchSettled,
  type Message,
  type OrchestrationStore,
  type RoleStore,
  type Workspace,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import type { CheckCommandPolicy } from './checkCommand';
import { createOrchestrationHost, type RunChecksFn } from './host';
import { fail, guard } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';
import { currentBranch, readDispatchOutput, reviewWorktreeDiff } from './queries';
import { createWorkerHost } from './workerHost';
import { cleanupMergedWorktree, type MergedCleanupResult } from './worktreeCleanup';

export interface OrchestrationServiceOptions {
  workspace: Workspace;
  /** 状态快照：`userData/orchestration/<workspaceId>.json`。 */
  statePath: string;
  /** worktree 托管根目录，每次建 worktree 时调用（registry 按设置推导，见 `worktreesRoot.ts`）。 */
  resolveWorktreesRoot: (workspace: Workspace) => Promise<string>;
  launcher: WorkerSessionLauncher;
  roles: RoleStore;
  exec: ExecFn;
  runChecks: RunChecksFn;
  fs: CoreFs;
  /** 状态变更后调用（同一轮里的多次变更合并为一次）；ipc 层接 `orchestration:changed` 广播。 */
  notifyChanged: (workspaceId: string) => void;
  /** 收件箱每投递一条消息（worker_done / question / escalation …）就同步调用；从快照恢复的不算。桌面通知用。 */
  onMessagePosted?: (message: Message) => void;
  checkPolicy?: CheckCommandPolicy;
  log?: (message: string) => void;
  now?: () => number;
}

/** 一个工作区的编排状态与它的 Host 们（ARCHITECTURE §9.5 中 Main 一侧的实现）。 */
export interface OrchestrationService {
  readonly workspace: Workspace;
  /** 快照加载完成（读不了时以空状态开始并记日志）；从不 reject。 */
  readonly ready: Promise<void>;
  /**
   * 主 agent 会话的 OrchestrationHost；首次调用时确定它所在的分支（仓库当时检出的分支）。
   * 普通目录（`vcs: 'none'`）不读分支，编排原地进行、不调用 git。
   */
  hostFor(coordinatorSessionId: string): OrchestrationHost;
  /** worker 会话的 WorkerHost：按 `Dispatch.workerSessionId` 反查；不是 worker（或状态未加载）返回 null。 */
  workerHostFor(sessionId: string): WorkerHost | null;
  /** Run 的主 agent 会话（worker 会话的 parentSessionId）；起 worker 会话时 Run 已经落库。 */
  coordinatorOf(runId: string): string | undefined;
  hasDispatch(dispatchId: string): boolean;
  /** 面板用的完整快照（§9.4）。 */
  snapshot(): Promise<OrchestrationSnapshotView>;
  readWorkerOutput(input: {
    dispatchId: string;
    cursor: number;
  }): Promise<HostResult<ReadWorkerOutputOutput>>;
  reviewDiff(dispatchId: string): Promise<HostResult<ReviewDiffOutput>>;
  /**
   * 归档 worker 会话时调用（「通用 → 会话 → 归档时清理 worktree」）：它的 worktree 已合并且干净就删掉
   * worktree 与分支，否则保留（见 `worktreeCleanup.ts`）。
   */
  cleanupMergedWorktree(sessionId: string): Promise<MergedCleanupResult>;
  /** 等待所有落盘完成并写入当前状态。 */
  flush(): Promise<void>;
}

function observe<T extends { id: string }>(
  table: EntityTable<T>,
  changed: () => void,
  inserted?: (entity: T) => void
): EntityTable<T> {
  const notify = <R extends { ok: boolean }>(result: R): R => {
    if (result.ok) changed();
    return result;
  };
  return {
    insert: (entity) => {
      const result = notify(table.insert(entity));
      if (result.ok) inserted?.(result.value);
      return result;
    },
    get: (id) => table.get(id),
    update: (id, patch) => notify(table.update(id, patch)),
    delete: (id) => {
      const deleted = table.delete(id);
      if (deleted) changed();
      return deleted;
    },
    list: (filter) => table.list(filter),
  };
}

/**
 * 包一层 store：经它的每次成功写入都触发 `changed`（Inbox 的 post / ack 也写 messages 表）；
 * 新插入的消息（即 Inbox 的 post）再交给 `messagePosted`。
 */
function observeStore(
  store: OrchestrationStore,
  changed: () => void,
  messagePosted?: (message: Message) => void
): OrchestrationStore {
  return {
    runs: observe(store.runs, changed),
    tasks: observe(store.tasks, changed),
    dispatches: observe(store.dispatches, changed),
    worktrees: observe(store.worktrees, changed),
    messages: observe(store.messages, changed, messagePosted),
    listTasks: (runId) => store.listTasks(runId),
    activeDispatch: (taskId) => store.activeDispatch(taskId),
    reclaimableDispatches: (runId) => store.reclaimableDispatches(runId),
    snapshot: () => store.snapshot(),
  };
}

type HostLookup = Promise<HostResult<{ host: OrchestrationHost }>>;

/** 同步拿到的 Host：每次调用先等真正的 Host 就绪（状态加载、分支确定）。 */
function deferredHost(resolve: () => HostLookup): OrchestrationHost {
  const call = async <R extends object>(
    invoke: (host: OrchestrationHost) => Promise<HostResult<R>>
  ): Promise<HostResult<R>> => {
    const resolved = await resolve();
    return resolved.ok ? invoke(resolved.host) : resolved;
  };
  return {
    dispatchTask: (input, signal) => call((host) => host.dispatchTask(input, signal)),
    listWorkers: (signal) => call((host) => host.listWorkers(signal)),
    waitForWorkers: (input, signal) => call((host) => host.waitForWorkers(input, signal)),
    readWorkerOutput: (input, signal) => call((host) => host.readWorkerOutput(input, signal)),
    sendToWorker: (input, signal) => call((host) => host.sendToWorker(input, signal)),
    reviewDiff: (input, signal) => call((host) => host.reviewDiff(input, signal)),
    runChecks: (input, signal) => call((host) => host.runChecks(input, signal)),
    mergeWorktree: (input, signal) => call((host) => host.mergeWorktree(input, signal)),
    rejectWork: (input, signal) => call((host) => host.rejectWork(input, signal)),
    cleanupWorktree: (input, signal) => call((host) => host.cleanupWorktree(input, signal)),
  };
}

/**
 * 每个工作区一个：`InMemoryOrchestrationStore` + 快照文件、`Inbox`（消息随快照持久化）、
 * `GitWorktreeManager`。经它的写入会合并到一个微任务里落盘并调用 `notifyChanged`。
 */
export function createOrchestrationService(
  options: OrchestrationServiceOptions
): OrchestrationService {
  const { workspace, launcher, statePath, fs } = options;
  const log = options.log ?? ((message: string) => console.warn(`[orchestration] ${message}`));
  const now = options.now ?? Date.now;
  const inner = new InMemoryOrchestrationStore();
  let loaded = false;
  let flushQueued = false;

  const persist = async (): Promise<void> => {
    const result = await inner.persistTo(statePath, fs);
    if (!result.ok) log(result.error);
  };
  const changed = (): void => {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      void persist();
      options.notifyChanged(workspace.id);
    });
  };

  const store = observeStore(inner, changed, (message) => {
    try {
      options.onMessagePosted?.(message);
    } catch (error) {
      log(`message listener failed: ${errorMessage(error)}`);
    }
  });
  const inbox = new Inbox({ messages: store.messages, now });
  const git = new GitWorktreeManager({ exec: options.exec });

  const ready = (async () => {
    try {
      const result = await inner.loadFrom(statePath, fs);
      if (!result.ok) {
        log(`${result.error}; starting with an empty orchestration state`);
        // 读不懂的文件挪到一边，下一次写入才不会把它覆盖掉
        await fs.rename(statePath, `${statePath}.unreadable-${Date.now()}`).catch(() => undefined);
      }
    } catch (error) {
      log(errorMessage(error));
    } finally {
      loaded = true;
    }
  })();

  const hosts = new Map<string, HostLookup>();
  const resolveHost = (coordinatorSessionId: string): HostLookup => {
    const cached = hosts.get(coordinatorSessionId);
    if (cached !== undefined) return cached;
    const lookup = (async (): HostLookup => {
      await ready;
      // 普通目录可能是某个仓库的子目录，git 读得到外层仓库的分支，所以按 vcs 判断而不是看 git 读不读得到
      const branch =
        workspace.vcs === 'none' ? '' : await currentBranch(options.exec, workspace.repoPath);
      if (branch === undefined) {
        return fail(
          `the workspace repository ${workspace.repoPath} is not on a branch (detached HEAD) or cannot be read; check out the branch the orchestrator should work on`
        );
      }
      const host = createOrchestrationHost({
        workspace,
        coordinatorSessionId,
        coordinatorBranch: branch,
        store,
        git,
        inbox,
        launcher,
        roles: options.roles,
        runChecks: options.runChecks,
        resolveWorktreesRoot: options.resolveWorktreesRoot,
        exec: options.exec,
        checkPolicy: options.checkPolicy,
        now,
      });
      return { ok: true, host };
    })();
    hosts.set(coordinatorSessionId, lookup);
    // 失败（如 detached HEAD）不缓存：用户切回分支后下一次调用就能用
    void lookup.then((result) => {
      if (!result.ok) hosts.delete(coordinatorSessionId);
    });
    return lookup;
  };

  /** 该会话当前的尝试：进行中的优先，否则最近一次（打回后同一会话会有多次尝试）。 */
  const dispatchOfSession = (sessionId: string): Dispatch | undefined => {
    const own = store.dispatches.list((dispatch) => dispatch.workerSessionId === sessionId);
    return own.find((dispatch) => !isDispatchSettled(dispatch)) ?? own.at(-1);
  };

  const bindWorker = (sessionId: string): HostResult<{ host: WorkerHost }> => {
    const dispatch = dispatchOfSession(sessionId);
    const runId = dispatch && store.tasks.get(dispatch.taskId)?.runId;
    if (dispatch === undefined || runId === undefined) {
      return fail(`session ${sessionId} has no orchestration dispatch`);
    }
    return {
      ok: true,
      host: createWorkerHost({ store, inbox, runId, dispatchId: dispatch.id, now }),
    };
  };

  return {
    workspace,
    ready,

    hostFor: (coordinatorSessionId) => deferredHost(() => resolveHost(coordinatorSessionId)),

    workerHostFor(sessionId) {
      if (!loaded || dispatchOfSession(sessionId) === undefined) return null;
      // 每次调用重新绑定：reject_work 之后同一个会话换成了新的尝试
      return {
        askCoordinator: async (question, timeoutMs, signal) => {
          const bound = bindWorker(sessionId);
          return bound.ok ? bound.host.askCoordinator(question, timeoutMs, signal) : bound;
        },
        reportDone: async (outcome, summary, filesModified) => {
          const bound = bindWorker(sessionId);
          return bound.ok ? bound.host.reportDone(outcome, summary, filesModified) : bound;
        },
      };
    },

    coordinatorOf: (runId) => (loaded ? store.runs.get(runId)?.coordinatorSessionId : undefined),

    hasDispatch: (dispatchId) => loaded && store.dispatches.get(dispatchId) !== undefined,

    async snapshot() {
      await ready;
      const { version: _version, ...view } = inner.snapshot();
      return view;
    },

    readWorkerOutput: (input) =>
      guard(async () => {
        await ready;
        const dispatch = store.dispatches.get(input.dispatchId);
        if (dispatch === undefined) return fail(`unknown dispatch ${input.dispatchId}`);
        return readDispatchOutput({ store, launcher }, dispatch, input.cursor);
      }),

    reviewDiff: (dispatchId) =>
      guard(async () => {
        await ready;
        const dispatch = store.dispatches.get(dispatchId);
        if (dispatch === undefined) return fail(`unknown dispatch ${dispatchId}`);
        if (dispatch.mode === 'in-place') {
          return fail(`dispatch ${dispatchId} has no diff: the workspace has no git`);
        }
        const worktree = store.worktrees.get(dispatch.worktreeId);
        if (worktree === undefined) {
          return fail(`the worktree of dispatch ${dispatchId} was already cleaned up`);
        }
        return reviewWorktreeDiff({ git, exec: options.exec }, worktree);
      }),

    async cleanupMergedWorktree(sessionId) {
      await ready;
      const deps = { store, git, launcher, repoPath: workspace.repoPath };
      return cleanupMergedWorktree(deps, dispatchOfSession(sessionId));
    },

    async flush() {
      await ready;
      await persist();
    },
  };
}
