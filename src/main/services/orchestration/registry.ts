import * as nodeFs from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import {
  type CoreFs,
  type ExecFn,
  type Message,
  parseOrchestrationSnapshot,
  type RoleStore,
  type Workflow,
  type Workspace,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import { collectAppSecrets, type LocalInfoContext } from '../secrets';
import type { CheckCommandPolicy } from './checkCommand';
import type { RunChecksFn } from './host';
import type { WorkerSessionLauncher } from './launcher';
import { nodeExec } from './nodeExec';
import type { PullRequestGateDeps } from './pullRequest';
import {
  type CoordinatorWork,
  createOrchestrationService,
  type OrchestrationService,
} from './service';
import { createShellRunner } from './shellRunner';
import { createWorktreesRootResolver, fallbackWorktreesRoot } from './worktreesRoot';

export interface OrchestrationRegistryOptions {
  /** `app.getPath('userData')`：快照写到 `orchestration/<workspaceId>.json`；worktree 的默认位置用不了时退到 `worktrees/`。 */
  userDataPath: string;
  /** 已挂入的工作区（含 repoPath，只在 Main）。 */
  listWorkspaces: () => readonly Workspace[];
  /**
   * `preferences.worktreesRoot`，每次建 worktree 时现读；缺省或返回 undefined 时 worktree 建在仓库同级的
   * `<仓库目录名>-worktrees`（见 `worktreesRoot.ts`）。
   */
  worktreesRoot?: () => string | undefined;
  roles: RoleStore;
  notifyChanged: (workspaceId: string) => void;
  /** 工作区里某个主 agent 会话的 {@link OrchestrationRegistry.hasActiveWork} 翻转了（生产广播 sessions:changed） */
  activeWorkChanged?: (workspaceId: string) => void;
  /** 缺省时起 worker 会话一律失败，直到 {@link OrchestrationRegistry.setLauncher}。 */
  launcher?: WorkerSessionLauncher;
  exec?: ExecFn;
  runChecks?: RunChecksFn;
  fs?: CoreFs;
  checkPolicy?: CheckCommandPolicy;
  /** 用户定义的工作流（生产为 workflows.json 注册表）；缺省时不能按工作流派发 */
  workflows?: { list(): Promise<readonly Workflow[]> };
  log?: (message: string) => void;
  /** open_pull_request 推送闸门的数据；缺省读 providers.json / mcp.json / 环境变量与本机路径 */
  pullRequestGate?: PullRequestGateDeps;
  /** 主 agent 会话是否受限，原样传给各服务；缺省都不受限，直到 {@link OrchestrationRegistry.setRestrictedCoordinatorLookup} */
  isRestrictedCoordinator?: (coordinatorSessionId: string) => boolean;
}

/** Main 内所有工作区的 OrchestrationService；agent-host 的两个工厂与 orchestration IPC 都经它查找。 */
export interface OrchestrationRegistry {
  /** 接上 agent-host 的 `implementsLauncher()`；已打开的服务随即改用它。 */
  setLauncher(launcher: WorkerSessionLauncher): void;
  /** 接上 agent-host 的「主 agent 会话是否受限」查询；已打开的服务随即改用它。 */
  setRestrictedCoordinatorLookup(lookup: (coordinatorSessionId: string) => boolean): void;
  /** 工作区的服务，首次访问时创建并开始加载快照；工作区不存在时 `undefined`。 */
  serviceFor(workspaceId: string): OrchestrationService | undefined;
  /** Read current/persisted state without opening a service or repairing files. */
  readSnapshot(workspaceId: string): Promise<OrchestrationSnapshotView | undefined>;
  /** 打开全部工作区并等快照加载完：{@link OrchestrationRegistry.workerHostFor} 只认已加载的状态。 */
  openAll(): Promise<void>;
  /** 给 `agentHost.setOrchestrationHostFactory`。 */
  hostFor(coordinatorSessionId: string, workspaceId: string): OrchestrationHost | null;
  /** 给 `agentHost.setWorkerHostFactory`：在已打开的服务里按 `Dispatch.workerSessionId` 反查。 */
  workerHostFor(sessionId: string): WorkerHost | null;
  /** 给 `agentHost.setCoordinatorLookup`：worker 会话的 parentSessionId 经 Run 反查主 agent 会话。 */
  coordinatorOf(workspaceId: string, runId: string): string | undefined;
  /** 持有该 dispatch 的服务（先打开全部工作区）。 */
  serviceForDispatch(dispatchId: string): Promise<OrchestrationService | undefined>;
  /** worker 会话一轮正常结束且已空闲：转给各服务，当前尝试未汇报的通知主 agent。协调者唤醒器用。 */
  workerRunEnded(sessionId: string): void;
  /** 收件箱里发给该会话、未确认的消息（跨工作区查找，不消费）。协调者唤醒器用。 */
  pendingMessagesTo(sessionId: string): Message[];
  /** Read current actionable messages and unresolved successful attempts, without consuming either. */
  coordinatorWork(sessionId: string): CoordinatorWork;
  /** 主 agent 会话在任一已打开的工作区里有未完成的编排任务 */
  hasActiveWork(sessionId: string): boolean;
  /** worker 会话的任务已失败、当前尝试已结算（跨工作区查找）：用户消息应拒绝，提示由主 agent reject_work 重试 */
  retryRequired(sessionId: string): { taskId: string; title: string } | undefined;
  /** 确认已投递的消息（各服务尽力而为）。 */
  ackMessages(ids: readonly string[]): void;
  flushAll(): Promise<void>;
  /**
   * 订阅各工作区收件箱新投递的消息（含之后才打开的服务；从快照恢复的不算），桌面通知用。
   * 监听器抛异常只记日志。返回取消订阅。
   */
  onMessage(listener: (workspaceId: string, message: Message) => void): () => void;
}

export const UNWIRED_LAUNCHER_ERROR =
  'worker sessions are unavailable: the agent host is not connected to orchestration yet';

const unwiredLauncher: WorkerSessionLauncher = {
  createWorkerSession: async () => ({ ok: false, error: UNWIRED_LAUNCHER_ERROR }),
  promptSession: async () => ({ ok: false, error: UNWIRED_LAUNCHER_ERROR }),
  readTranscript: async () => ({ ok: false, error: UNWIRED_LAUNCHER_ERROR }),
  disposeSession: async () => {},
};

export function createOrchestrationRegistry(
  options: OrchestrationRegistryOptions
): OrchestrationRegistry {
  let launcher = options.launcher ?? unwiredLauncher;
  // 服务拿到的是转发到「当前」launcher 的代理，setLauncher 之前打开的服务也会用上新的
  const delegate: WorkerSessionLauncher = {
    createWorkerSession: (input) => launcher.createWorkerSession(input),
    promptSession: (sessionId, text, options) => launcher.promptSession(sessionId, text, options),
    readTranscript: (sessionId, cursor) => launcher.readTranscript(sessionId, cursor),
    sessionFailure: (sessionId) => launcher.sessionFailure?.(sessionId),
    disposeSession: (sessionId, options) => launcher.disposeSession(sessionId, options),
  };
  let isRestrictedCoordinator = options.isRestrictedCoordinator ?? (() => false);
  const exec = options.exec ?? nodeExec;
  const runChecks = options.runChecks ?? createShellRunner();
  const fs = options.fs ?? nodeFs;
  const resolveWorktreesRoot = createWorktreesRootResolver({
    fallbackRoot: fallbackWorktreesRoot(options.userDataPath),
    configured: options.worktreesRoot ?? (() => undefined),
    repoPaths: () => options.listWorkspaces().map((workspace) => workspace.repoPath),
    log: options.log,
  });
  const localInfo = async (): Promise<LocalInfoContext> => {
    const workspaces = options.listWorkspaces();
    const roots = await Promise.all(
      workspaces.map((workspace) => resolveWorktreesRoot(workspace).catch(() => undefined))
    );
    let userName: string | undefined;
    try {
      userName = userInfo().username;
    } catch {
      // 没有用户记录时只按路径与主机名检查
    }
    return {
      paths: [
        homedir(),
        tmpdir(),
        options.userDataPath,
        fallbackWorktreesRoot(options.userDataPath),
        ...workspaces.map((workspace) => workspace.repoPath),
        ...roots.filter((root): root is string => root !== undefined),
      ],
      ...(userName ? { userName } : {}),
      hostName: hostname(),
    };
  };
  const pullRequestGate = options.pullRequestGate ?? {
    knownSecrets: collectAppSecrets,
    localInfo,
  };
  const services = new Map<string, OrchestrationService>();
  const reconcileWorkers = () => {
    for (const service of services.values()) service.reconcileWorkers();
  };
  let unsubscribeFailures = launcher.onSessionFailure?.(reconcileWorkers);
  const messageListeners = new Set<(workspaceId: string, message: Message) => void>();
  const log = options.log ?? ((message: string) => console.warn(`[orchestration] ${message}`));

  const announce = (workspaceId: string, message: Message): void => {
    for (const listener of messageListeners) {
      try {
        listener(workspaceId, message);
      } catch (error) {
        log(`message listener failed: ${errorMessage(error)}`);
      }
    }
  };

  // 各工作区上次通知时有未完成任务的主 agent；只在集合变了时通知，避免每次编排变更都广播
  const lastActive = new Map<string, Set<string>>();
  const checkActiveWork = (workspaceId: string): void => {
    const service = services.get(workspaceId);
    if (service === undefined || options.activeWorkChanged === undefined) return;
    const next = service.activeCoordinators();
    const previous = lastActive.get(workspaceId) ?? new Set<string>();
    lastActive.set(workspaceId, next);
    if (next.size !== previous.size || [...next].some((id) => !previous.has(id)))
      options.activeWorkChanged(workspaceId);
  };

  const open = (workspace: Workspace): OrchestrationService => {
    const existing = services.get(workspace.id);
    if (existing !== undefined) return existing;
    const service = createOrchestrationService({
      workspace,
      statePath: join(options.userDataPath, 'orchestration', `${workspace.id}.json`),
      resolveWorktreesRoot,
      launcher: delegate,
      roles: options.roles,
      exec,
      runChecks,
      fs,
      notifyChanged: (workspaceId) => {
        options.notifyChanged(workspaceId);
        checkActiveWork(workspaceId);
      },
      onMessagePosted: (message) => announce(workspace.id, message),
      checkPolicy: options.checkPolicy,
      ...(options.workflows ? { workflows: options.workflows } : {}),
      canLaunch: () => launcher !== unwiredLauncher,
      log: options.log,
      pullRequestGate,
      isRestrictedCoordinator: (sessionId) => isRestrictedCoordinator(sessionId),
    });
    services.set(workspace.id, service);
    return service;
  };

  const reopening = new Set<string>();
  const findWorkspace = (workspaceId: string): Workspace | undefined =>
    options.listWorkspaces().find((candidate) => candidate.id === workspaceId);
  /**
   * 服务创建时固定了工作区的 vcs（原地 / worktree）。vcs 变了（如用户 git init）且服务空闲时，
   * 像退出时一样先落盘再按新记录重开；不空闲就继续用旧模式，下一次 serviceFor 再看。
   */
  const reopenIfVcsChanged = (existing: OrchestrationService): void => {
    const id = existing.workspace.id;
    const stale = () =>
      services.get(id) === existing &&
      existing.isIdle() &&
      findWorkspace(id)?.vcs !== undefined &&
      findWorkspace(id)?.vcs !== existing.workspace.vcs;
    if (reopening.has(id) || !stale()) return;
    reopening.add(id);
    void existing
      .flush()
      .then(() => {
        const workspace = findWorkspace(id);
        if (!stale() || workspace === undefined) return;
        services.delete(id);
        open(workspace);
      })
      .catch((error: unknown) => log(`reopen ${id} failed: ${errorMessage(error)}`))
      .finally(() => reopening.delete(id));
  };

  const serviceFor = (workspaceId: string): OrchestrationService | undefined => {
    const existing = services.get(workspaceId);
    if (existing !== undefined) {
      reopenIfVcsChanged(existing);
      return existing;
    }
    const workspace = findWorkspace(workspaceId);
    return workspace === undefined ? undefined : open(workspace);
  };

  const openAll = async (): Promise<void> => {
    await Promise.all(options.listWorkspaces().map((workspace) => open(workspace).ready));
  };

  return {
    setLauncher(next) {
      unsubscribeFailures?.();
      launcher = next;
      unsubscribeFailures = launcher.onSessionFailure?.(reconcileWorkers);
      reconcileWorkers();
    },
    setRestrictedCoordinatorLookup(lookup) {
      isRestrictedCoordinator = lookup;
    },
    serviceFor,
    async readSnapshot(workspaceId) {
      const existing = services.get(workspaceId);
      if (existing) return existing.snapshot({ reconcile: false });
      if (!options.listWorkspaces().some((workspace) => workspace.id === workspaceId))
        return undefined;
      try {
        const text = await fs.readFile(
          join(options.userDataPath, 'orchestration', `${workspaceId}.json`),
          'utf8'
        );
        const parsed = parseOrchestrationSnapshot(JSON.parse(text));
        if (!parsed.ok) return undefined;
        const { version: _version, ...snapshot } = parsed.snapshot;
        return snapshot;
      } catch {
        return undefined;
      }
    },
    openAll,
    hostFor: (coordinatorSessionId, workspaceId) =>
      serviceFor(workspaceId)?.hostFor(coordinatorSessionId) ?? null,
    workerHostFor(sessionId) {
      for (const service of services.values()) {
        const host = service.workerHostFor(sessionId);
        if (host !== null) return host;
      }
      return null;
    },
    coordinatorOf: (workspaceId, runId) => services.get(workspaceId)?.coordinatorOf(runId),
    async serviceForDispatch(dispatchId) {
      await openAll();
      return [...services.values()].find((service) => service.hasDispatch(dispatchId));
    },
    async flushAll() {
      await Promise.all([...services.values()].map((service) => service.flush()));
    },
    workerRunEnded(sessionId) {
      for (const service of services.values()) service.workerRunEnded(sessionId);
    },
    pendingMessagesTo(sessionId: string): Message[] {
      for (const service of services.values()) {
        const pending = service.pendingMessagesTo(sessionId);
        if (pending.length > 0) return pending;
      }
      return [];
    },
    coordinatorWork(sessionId) {
      const work = [...services.values()].map((service) => service.coordinatorWork(sessionId));
      return {
        messages: work.flatMap((entry) => entry.messages),
        reviews: work.flatMap((entry) => entry.reviews),
      };
    },
    hasActiveWork: (sessionId) =>
      [...services.values()].some((service) => service.hasActiveWork(sessionId)),
    retryRequired(sessionId) {
      for (const service of services.values()) {
        const found = service.retryRequired(sessionId);
        if (found) return found;
      }
      return undefined;
    },
    ackMessages(ids: readonly string[]): void {
      for (const service of services.values()) service.ackMessages(ids);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
  };
}
