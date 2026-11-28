import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HostResult,
  OrchestrationHost,
  ReadWorkerOutputOutput,
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
  recordWorkflowNodeReport,
  settleDispatch,
  type Task,
  type Workflow,
  type Workspace,
  workflowRunningDispatchIds,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import type { CheckCommandPolicy } from './checkCommand';
import { createOrchestrationHost, type RunChecksFn } from './host';
import { fail, guard } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';
import type { PullRequestGateDeps } from './pullRequest';
import {
  currentBranch,
  type PanelReviewDiff,
  publicBaseRef,
  readDispatchOutput,
  reviewDispatchPanelDiff,
} from './queries';
import { createWorkerHost } from './workerHost';
import { createWorkflowEngine } from './workflowEngine';
import {
  checkSessionWorktree,
  cleanupMergedWorktree,
  type MergedCleanupBlocker,
  type MergedCleanupResult,
  removeTree,
  unlinkLinksIn,
} from './worktreeCleanup';

/** 删除会话时删它 worktree 的结果：被挡住（任务进行中、未合并等）或删除失败时 worktree 与记录都保留 */
export type SessionWorktreeRemoval =
  | { ok: true }
  | { ok: false; reason: 'busy' | MergedCleanupBlocker }
  | { ok: false; reason: 'failed'; error: string };

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
  /** 用户定义的工作流（workflows.json 注册表）；缺省时不能按工作流派发 */
  workflows?: { list(): Promise<readonly Workflow[]> };
  /** launcher 是否已接线；未接线时不恢复工作流推进（接线后的对账会再来）。缺省视为已接线 */
  canLaunch?: () => boolean;
  log?: (message: string) => void;
  now?: () => number;
  /** open_pull_request 的推送闸门数据（见 `pullRequest.ts`）；缺省时该工具拒绝 */
  pullRequestGate?: PullRequestGateDeps;
  /** 主 agent 会话是否受限（受限的从公开基线 origin/<默认分支> 切出、推送闸门查保护路径）；缺省都不受限 */
  isRestrictedCoordinator?: (coordinatorSessionId: string) => boolean;
  /** 重新检测本工作区的 vcs 并返回检测后的值；工作区已不存在时返回 undefined。缺省不重新检测 */
  refreshVcs?: () => Promise<Workspace['vcs'] | undefined>;
}

/** Current successful attempt still awaiting a coordinator decision, independent of inbox delivery. */
export interface PendingCoordinatorReview {
  taskId: string;
  title: string;
  dispatch: Dispatch;
}

export interface CoordinatorWork {
  messages: Message[];
  reviews: PendingCoordinatorReview[];
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
  snapshot(options?: { reconcile?: boolean }): Promise<OrchestrationSnapshotView>;
  /** Only conclusive Main/session-registry evidence can settle an orphaned current attempt */
  reconcileWorkers(): void;
  /**
   * worker 会话一轮正常结束且已空闲（调用方负责延迟与会话状态检查）：当前尝试仍未结算时给主 agent 投一条
   * escalation（同 dispatch 未确认的不重复投）。不改任何状态，空闲不算失败。
   */
  workerRunEnded(sessionId: string): void;
  readWorkerOutput(input: {
    dispatchId: string;
    cursor: number;
  }): Promise<HostResult<ReadWorkerOutputOutput>>;
  /** 面板用：比 agent 的 review_diff 多未提交改动与提交列表。 */
  reviewDiff(dispatchId: string): Promise<HostResult<PanelReviewDiff>>;
  /**
   * 归档 worker 会话时调用（「通用 → 会话 → 归档时清理 worktree」）：它的 worktree 已合并且干净就删掉
   * worktree 与分支，否则保留（见 `worktreeCleanup.ts`）。
   */
  cleanupMergedWorktree(sessionId: string): Promise<MergedCleanupResult>;
  /** 删除会话前：它的 worktree 为何不能直接删（未合并、有改动、任务进行中）；null 为没有或可以直接删。 */
  sessionWorktreeBlocker(sessionId: string): Promise<'busy' | MergedCleanupBlocker | null>;
  /**
   * 删除会话时删它的 worktree 与分支：已合并且干净的同归档清理；被挡住的只在 `force` 时走
   * cleanup_worktree 的 abandon 路径（任务记为放弃）；任务还在进行时拒绝。
   */
  removeSessionWorktree(sessionId: string, force: boolean): Promise<SessionWorktreeRemoval>;
  /** 等待所有落盘完成并写入当前状态。 */
  flush(): Promise<void>;
  /** 收件箱里发给该会话、未确认的消息（不消费）；状态未加载时为空。协调者唤醒器用。 */
  pendingMessagesTo(sessionId: string): Message[];
  /** Current attempts only; acknowledged reports remain reviewable until the task changes state. */
  coordinatorWork(sessionId: string): CoordinatorWork;
  /** 该主 agent 会话的 Run 里有未完成的任务（口径同 {@link isIdle}）；状态未加载时 false。 */
  hasActiveWork(sessionId: string): boolean;
  /**
   * worker 会话的当前尝试已结算且任务 failed：用户直接发消息也交不上结果，须由主 agent reject_work 重试。
   * 其他情况（非 worker、未结算、其他状态、未加载）为 undefined。
   */
  retryRequired(sessionId: string): { taskId: string; title: string } | undefined;
  /** 有未完成任务的主 agent 会话（口径同 {@link hasActiveWork}），注册表做翻转检测用。 */
  activeCoordinators(): Set<string>;
  /** 确认已投递的消息（尽力而为，幂等）。 */
  ackMessages(ids: readonly string[]): void;
  /** 状态已加载且没有排队 / 进行中 / 待审的任务、没有运行中的工作流节点：可以换掉服务（如工作区 vcs 变了）。 */
  isIdle(): boolean;
}

/** 排队 / 进行中 / 待审，或工作流还有运行中节点、待启动意图的任务 */
function isActiveTask(task: Task): boolean {
  return (
    task.status === 'todo' ||
    task.status === 'in-progress' ||
    task.status === 'in-review' ||
    (task.workflow !== undefined &&
      (task.workflow.launches.length > 0 ||
        task.workflow.nodes.some((node) => node.status === 'running')))
  );
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
    activeDispatches: (taskId) => store.activeDispatches(taskId),
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
    openPullRequest: (input, signal) => call((host) => host.openPullRequest(input, signal)),
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
  const pendingDispatches = new Set<string>();

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
  // git worktree remove 删不掉超长路径时的兜底（Node/libuv 能处理 Windows 长路径）
  const git = new GitWorktreeManager({
    exec: options.exec,
    removeDir: removeTree,
    pathKind: async (path) => {
      try {
        const stat = await lstat(path);
        return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
      }
    },
    // Git for Windows 把 junction 当目录递归删除；macOS / Linux 的 git 不跟随符号链接，不注入以免碰被跟踪的链接
    ...(process.platform === 'win32'
      ? { detachLinks: (path: string) => unlinkLinksIn(path, { keepInside: path }) }
      : {}),
  });
  const workflowEngine = createWorkflowEngine({
    workspace,
    store,
    inbox,
    launcher,
    git,
    exec: options.exec,
    resolveWorktreesRoot: options.resolveWorktreesRoot,
    now,
    log,
    ...(options.canLaunch ? { canLaunch: options.canLaunch } : {}),
  });

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

  function reconcileWorkers(): void {
    if (!loaded) return;
    // 工作流：按持久化的节点状态与启动意图恢复推进（崩溃恢复）
    workflowEngine.resume();
    if (!launcher.sessionFailure) return;
    reconcileWorkflowNodes(launcher.sessionFailure);
    // Use insertion order, including settled attempts: an old unsettled row must not win over a retry.
    const latest = new Map(store.dispatches.list().map((dispatch) => [dispatch.taskId, dispatch]));
    for (const task of store.tasks.list(
      (entry) => entry.status === 'in-progress' && entry.workflow === undefined
    )) {
      const dispatch = latest.get(task.id);
      if (!dispatch || isDispatchSettled(dispatch) || pendingDispatches.has(dispatch.id)) continue;
      const run = store.runs.get(task.runId);
      if (!run) continue;
      const reason = launcher.sessionFailure(dispatch.workerSessionId);
      if (!reason) continue;
      // No awaits between evidence, current-attempt validation and writes.
      if (
        store.tasks.get(task.id)?.status !== 'in-progress' ||
        store.dispatches.list((entry) => entry.taskId === task.id).at(-1)?.id !== dispatch.id ||
        isDispatchSettled(store.dispatches.get(dispatch.id) ?? dispatch)
      )
        continue;
      const settled = settleDispatch(dispatch, 'failed', reason, dispatch.filesModified, now());
      if (!settled.ok) continue;
      const { id: _id, ...patch } = settled.dispatch;
      // Preserve any pre-existing partial report as evidence alongside the interruption reason.
      if (dispatch.summary) patch.summary = `${dispatch.summary}\n\n${reason}`;
      if (!store.dispatches.update(dispatch.id, patch).ok) continue;
      store.tasks.update(task.id, { status: 'failed' });
      inbox.post({
        runId: task.runId,
        dispatchId: dispatch.id,
        from: 'fynvra',
        to: run.coordinatorSessionId,
        type: 'worker_done',
        subject: 'failed',
        body: reason,
      });
    }
  }
  /**
   * 工作流节点的会话确定已失败：该节点按 failed 结算（同 report_done failed），由引擎汇总。
   * 并行节点各有一个未结算的尝试：逐个检查运行中节点绑定的尝试和任务全部未结算的尝试。
   * 没有绑定到运行中节点、也不属于待启动意图的孤儿尝试会话已死时只结算它自己（否则同一节点再也起不来）。
   */
  function reconcileWorkflowNodes(sessionFailure: (sessionId: string) => string | undefined) {
    for (const task of store.tasks.list(
      (entry) => entry.status === 'in-progress' && entry.workflow !== undefined
    )) {
      if (task.workflow === undefined) continue;
      const running = workflowRunningDispatchIds(task.workflow);
      const launching = new Set(task.workflow.launches.map((launch) => launch.dispatchId));
      for (const orphan of store.activeDispatches(task.id)) {
        if (running.includes(orphan.id) || launching.has(orphan.id)) continue;
        if (pendingDispatches.has(orphan.id)) continue;
        const reason = sessionFailure(orphan.workerSessionId);
        if (!reason) continue;
        const settled = settleDispatch(orphan, 'failed', reason, orphan.filesModified, now());
        if (!settled.ok) continue;
        const { id: _id, ...patch } = settled.dispatch;
        if (store.dispatches.update(orphan.id, patch).ok) workflowEngine.advance(task.id);
      }
      for (const dispatchId of running) {
        const dispatch = store.dispatches.get(dispatchId);
        if (!dispatch || isDispatchSettled(dispatch) || pendingDispatches.has(dispatch.id))
          continue;
        const reason = sessionFailure(dispatch.workerSessionId);
        if (!reason) continue;
        // No awaits between evidence, current-state validation and writes.
        const current = store.tasks.get(task.id);
        if (current?.status !== 'in-progress' || current.workflow === undefined) continue;
        const settled = settleDispatch(dispatch, 'failed', reason, dispatch.filesModified, now());
        if (!settled.ok) continue;
        const { id: _id, ...patch } = settled.dispatch;
        if (dispatch.summary) patch.summary = `${dispatch.summary}\n\n${reason}`;
        const next = recordWorkflowNodeReport(current.workflow, {
          dispatchId: dispatch.id,
          outcome: 'failed',
          summary: patch.summary ?? reason,
          at: patch.settledAt ?? now(),
        });
        if (next === undefined || !store.dispatches.update(dispatch.id, patch).ok) continue;
        store.tasks.update(task.id, { workflow: next });
        workflowEngine.advance(task.id);
      }
    }
  }
  void ready.then(reconcileWorkers);

  const hosts = new Map<string, HostLookup>();
  const resolveHost = (coordinatorSessionId: string): HostLookup => {
    const cached = hosts.get(coordinatorSessionId);
    if (cached !== undefined) return cached;
    const lookup = (async (): HostLookup => {
      await ready;
      const restricted = options.isRestrictedCoordinator?.(coordinatorSessionId) ?? false;
      let branch: string | undefined;
      let hostWorkspace = workspace;
      if (restricted) {
        // 受限协调者只从公开基线切出：本地分支上可能有用户没推送的私有提交，不能带进公开 PR；拿不到基线就拒绝
        const base = await publicBaseRef(options.exec, workspace);
        if (!base.ok) return base;
        branch = base.ref;
      } else {
        // 普通目录可能是某个仓库的子目录，git 读得到外层仓库的分支，所以按 vcs 判断而不是看 git 读不读得到
        branch =
          workspace.vcs === 'none' ? '' : await currentBranch(options.exec, workspace.repoPath);
        // 读不到分支（detached HEAD、git 读不了或没装、.git 失效）时派发不能卡住：降成原地派发
        if (branch === undefined) {
          // .git 被删或只剩空壳（没有 HEAD）时才重新检测并记为 none；其余情况不改 vcs 记录
          // 刷新失败（如写 settings 的 I/O 错误）只记日志：lookup 不能 reject，否则失败会被缓存
          if (workspace.vcs === 'git' && !(await hasGitHead(workspace.repoPath))) {
            await options.refreshVcs?.().catch((error: unknown) => {
              log(`refresh vcs of ${workspace.repoPath} failed: ${errorMessage(error)}`);
            });
          }
          log(`no branch readable in ${workspace.repoPath}; dispatching in place`);
          // shortcut: 降级只作用于这个 Host 且随 Host 缓存，服务与工作流引擎仍按 git 隔离，期间工作流任务直接拒绝；需要时再让引擎跟随新 vcs
          hostWorkspace = { ...workspace, vcs: 'none' };
          branch = '';
        }
      }
      const host = createOrchestrationHost({
        workspace: hostWorkspace,
        coordinatorSessionId,
        coordinatorBranch: branch,
        restricted,
        ...(hostWorkspace !== workspace ? { workflowsUnavailable: true } : {}),
        log,
        store,
        git,
        inbox,
        launcher,
        roles: options.roles,
        runChecks: options.runChecks,
        resolveWorktreesRoot: options.resolveWorktreesRoot,
        exec: options.exec,
        checkPolicy: options.checkPolicy,
        pendingDispatches,
        reconcileWorkers,
        ...(options.workflows ? { workflows: options.workflows } : {}),
        workflowEngine,
        now,
        ...(options.pullRequestGate ? { pullRequestGate: options.pullRequestGate } : {}),
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

  /** 该会话最近的已投递尝试；旧的未结算记录不能覆盖后来的尝试。 */
  const dispatchOfSession = (sessionId: string): Dispatch | undefined => {
    const own = store.dispatches.list(
      (dispatch) => dispatch.workerSessionId === sessionId && !pendingDispatches.has(dispatch.id)
    );
    return own.at(-1);
  };

  const bindWorker = (sessionId: string): HostResult<{ host: WorkerHost }> => {
    const dispatch = dispatchOfSession(sessionId);
    const runId = dispatch && store.tasks.get(dispatch.taskId)?.runId;
    if (dispatch === undefined || runId === undefined) {
      return fail(`session ${sessionId} has no orchestration dispatch`);
    }
    return {
      ok: true,
      host: createWorkerHost({
        store,
        inbox,
        runId,
        dispatchId: dispatch.id,
        now,
        advanceWorkflow: workflowEngine.advance,
      }),
    };
  };

  const activeCoordinators = (): Set<string> => {
    if (!loaded) return new Set();
    const runIds = new Set(store.tasks.list(isActiveTask).map((task) => task.runId));
    for (const id of pendingDispatches) {
      const taskId = store.dispatches.get(id)?.taskId;
      const runId = taskId === undefined ? undefined : store.tasks.get(taskId)?.runId;
      if (runId !== undefined) runIds.add(runId);
    }
    return new Set(
      store.runs.list((run) => runIds.has(run.id)).map((run) => run.coordinatorSessionId)
    );
  };

  return {
    workspace,
    ready,

    hostFor: (coordinatorSessionId) => deferredHost(() => resolveHost(coordinatorSessionId)),

    workerHostFor(sessionId) {
      if (!loaded || dispatchOfSession(sessionId) === undefined) return null;
      // Fixed to this attempt. AgentHost retains it until the next actual run starts.
      const bound = bindWorker(sessionId);
      return bound.ok ? bound.host : null;
    },

    coordinatorOf: (runId) => (loaded ? store.runs.get(runId)?.coordinatorSessionId : undefined),

    hasDispatch: (dispatchId) => loaded && store.dispatches.get(dispatchId) !== undefined,

    reconcileWorkers,

    workerRunEnded(sessionId) {
      if (!loaded) return;
      const dispatch = dispatchOfSession(sessionId);
      if (dispatch === undefined || isDispatchSettled(dispatch)) return;
      const task = store.tasks.get(dispatch.taskId);
      const run = task && store.runs.get(task.runId);
      if (task?.status !== 'in-progress' || run === undefined) return;
      if (task.workflow !== undefined) {
        if (!workflowRunningDispatchIds(task.workflow).includes(dispatch.id)) return;
      } else if (
        store.dispatches.list((entry) => entry.taskId === task.id).at(-1)?.id !== dispatch.id
      ) {
        return;
      }
      const coordinator = run.coordinatorSessionId;
      const duplicate = inbox
        .peek({ to: coordinator })
        .some(
          (message) =>
            message.type === 'escalation' &&
            message.from === 'fynvra' &&
            message.dispatchId === dispatch.id
        );
      if (duplicate) return;
      inbox.post({
        runId: run.id,
        dispatchId: dispatch.id,
        from: 'fynvra',
        to: coordinator,
        type: 'escalation',
        subject: 'worker stopped without report_done',
        body: `The worker of task ${task.id} ("${task.title}"), dispatch ${dispatch.id}, ended its turn without calling report_done; its session is idle and the attempt is still unsettled. read_worker_output keeps reporting "worker still running" until the attempt settles. Use send_to_worker to have it finish and call report_done, or decide otherwise.`,
      });
    },

    async snapshot({ reconcile = true } = {}) {
      await ready;
      if (reconcile) reconcileWorkers();
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
        return reviewDispatchPanelDiff(
          { git, exec: options.exec, store, repoPath: workspace.repoPath },
          dispatch
        );
      }),

    async cleanupMergedWorktree(sessionId) {
      await ready;
      const deps = { store, git, launcher, repoPath: workspace.repoPath };
      return cleanupMergedWorktree(deps, dispatchOfSession(sessionId));
    },

    async sessionWorktreeBlocker(sessionId) {
      await ready;
      const check = await checkSessionWorktree({ store, git }, dispatchOfSession(sessionId));
      // 读不了 git 状态时按「有改动」对待，删除前一定要用户确认
      if (typeof check === 'object') return 'dirty';
      return check === 'none' || check === 'clean' ? null : check;
    },

    async removeSessionWorktree(sessionId, force) {
      await ready;
      const dispatch = dispatchOfSession(sessionId);
      const check = await checkSessionWorktree({ store, git }, dispatch);
      if (typeof check === 'object') return { ok: false, reason: 'failed', error: check.error };
      if (check === 'none' || dispatch === undefined) return { ok: true };
      if (check === 'clean') {
        const result = await cleanupMergedWorktree(
          { store, git, launcher, repoPath: workspace.repoPath },
          dispatch
        );
        if (result.removed || result.reason === 'no-worktree') return { ok: true };
        if (result.reason === 'failed') return { ok: false, reason: 'failed', error: result.error };
        return { ok: false, reason: result.reason };
      }
      if (check === 'busy' || !force) return { ok: false, reason: check };
      const task = store.tasks.get(dispatch.taskId);
      const coordinator = task && store.runs.get(task.runId)?.coordinatorSessionId;
      if (task?.status === 'completed' || coordinator === undefined) {
        // 已验收任务合并后的新改动：abandon 路径按契约保留，不另写强删
        return {
          ok: false,
          reason: 'failed',
          error: `task ${dispatch.taskId} keeps work after it was merged (${check})`,
        };
      }
      const worktree = store.worktrees.get(dispatch.worktreeId);
      try {
        if (worktree) await unlinkLinksIn(worktree.path);
      } catch (error) {
        return { ok: false, reason: 'failed', error: errorMessage(error) };
      }
      const resolved = await resolveHost(coordinator);
      const result = resolved.ok
        ? await resolved.host.cleanupWorktree({ dispatchId: dispatch.id, abandon: true })
        : resolved;
      return result.ok ? { ok: true } : { ok: false, reason: 'failed', error: result.error };
    },

    async flush() {
      await ready;
      await persist();
    },

    isIdle: () =>
      loaded && pendingDispatches.size === 0 && store.tasks.list(isActiveTask).length === 0,

    pendingMessagesTo: (sessionId) => (loaded ? inbox.peek({ to: sessionId }) : []),

    coordinatorWork(sessionId) {
      if (!loaded) return { messages: [], reviews: [] };
      const runIds = new Set(
        store.runs.list((run) => run.coordinatorSessionId === sessionId).map((run) => run.id)
      );
      const tasks = store.tasks.list(
        (task) =>
          runIds.has(task.runId) && task.status !== 'completed' && task.status !== 'abandoned'
      );
      // Match host.latestDispatch: insertion order also disambiguates retries with equal timestamps.
      const latest = new Map(
        store.dispatches.list().map((dispatch) => [dispatch.taskId, dispatch])
      );
      const current = new Map(
        tasks.flatMap((task) => {
          // 运行中的工作流：每个运行中节点都是当前尝试（它们的提问都要送到）
          if (task.workflow !== undefined && task.status === 'in-progress') {
            return workflowRunningDispatchIds(task.workflow).flatMap((id) => {
              const dispatch = store.dispatches.get(id);
              return dispatch ? [[dispatch.id, { task, dispatch }] as const] : [];
            });
          }
          const dispatch = store.activeDispatch(task.id) ?? latest.get(task.id);
          return dispatch ? [[dispatch.id, { task, dispatch }] as const] : [];
        })
      );
      const messages = inbox.peek({ to: sessionId }).filter((message) => {
        if (!runIds.has(message.runId)) return false;
        if (!['worker_done', 'question', 'escalation'].includes(message.type)) return false;
        if (!message.dispatchId) return message.type === 'escalation';
        const attempt = current.get(message.dispatchId);
        if (!attempt || attempt.task.runId !== message.runId) return false;
        return (
          message.type !== 'worker_done' ||
          attempt.task.status === 'in-review' ||
          attempt.task.status === 'failed'
        );
      });
      const reviews = [...current.values()].flatMap(({ task, dispatch }) =>
        task.status === 'in-review' && dispatch.outcome === 'succeeded'
          ? [{ taskId: task.id, title: task.title, dispatch }]
          : []
      );
      return { messages, reviews };
    },

    hasActiveWork: (sessionId) => activeCoordinators().has(sessionId),
    retryRequired(sessionId) {
      if (!loaded) return undefined;
      const dispatch = dispatchOfSession(sessionId);
      if (dispatch === undefined || !isDispatchSettled(dispatch)) return undefined;
      const task = store.tasks.get(dispatch.taskId);
      return task?.status === 'failed' ? { taskId: task.id, title: task.title } : undefined;
    },
    activeCoordinators,

    ackMessages: (ids) => {
      for (const id of ids) inbox.ack(id);
    },
  };
}

/** `<repoPath>/.git/HEAD` 是否存在；.git 不存在、是文件或没有 HEAD 都算不存在 */
async function hasGitHead(repoPath: string): Promise<boolean> {
  try {
    await lstat(join(repoPath, '.git', 'HEAD'));
    return true;
  } catch {
    return false;
  }
}
