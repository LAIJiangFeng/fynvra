import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import type { CoreFs, ExecFn, RoleStore, Workspace } from '@fynvra/core';
import type { CheckCommandPolicy } from './checkCommand';
import type { RunChecksFn } from './host';
import type { WorkerSessionLauncher } from './launcher';
import { nodeExec } from './nodeExec';
import { createOrchestrationService, type OrchestrationService } from './service';
import { createShellRunner } from './shellRunner';

export interface OrchestrationRegistryOptions {
  /** `app.getPath('userData')`：快照写到 `orchestration/<workspaceId>.json`，worktree 建在 `worktrees/`。 */
  userDataPath: string;
  /** 已挂入的工作区（含 repoPath，只在 Main）。 */
  listWorkspaces: () => readonly Workspace[];
  roles: RoleStore;
  notifyChanged: (workspaceId: string) => void;
  /** 缺省时起 worker 会话一律失败，直到 {@link OrchestrationRegistry.setLauncher}。 */
  launcher?: WorkerSessionLauncher;
  exec?: ExecFn;
  runChecks?: RunChecksFn;
  fs?: CoreFs;
  checkPolicy?: CheckCommandPolicy;
  log?: (message: string) => void;
}

/** Main 内所有工作区的 OrchestrationService；agent-host 的两个工厂与 orchestration IPC 都经它查找。 */
export interface OrchestrationRegistry {
  /** 接上 agent-host 的 `implementsLauncher()`；已打开的服务随即改用它。 */
  setLauncher(launcher: WorkerSessionLauncher): void;
  /** 工作区的服务，首次访问时创建并开始加载快照；工作区不存在时 `undefined`。 */
  serviceFor(workspaceId: string): OrchestrationService | undefined;
  /** 打开全部工作区并等快照加载完：{@link OrchestrationRegistry.workerHostFor} 只认已加载的状态。 */
  openAll(): Promise<void>;
  /** 给 `agentHost.setOrchestrationHostFactory`。 */
  hostFor(coordinatorSessionId: string, workspaceId: string): OrchestrationHost | null;
  /** 给 `agentHost.setWorkerHostFactory`：在已打开的服务里按 `Dispatch.workerSessionId` 反查。 */
  workerHostFor(sessionId: string): WorkerHost | null;
  /** 持有该 dispatch 的服务（先打开全部工作区）。 */
  serviceForDispatch(dispatchId: string): Promise<OrchestrationService | undefined>;
  flushAll(): Promise<void>;
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
    promptSession: (sessionId, text) => launcher.promptSession(sessionId, text),
    readTranscript: (sessionId, cursor) => launcher.readTranscript(sessionId, cursor),
    disposeSession: (sessionId) => launcher.disposeSession(sessionId),
  };
  const exec = options.exec ?? nodeExec;
  const runChecks = options.runChecks ?? createShellRunner();
  const fs = options.fs ?? nodeFs;
  const services = new Map<string, OrchestrationService>();

  const open = (workspace: Workspace): OrchestrationService => {
    const existing = services.get(workspace.id);
    if (existing !== undefined) return existing;
    const service = createOrchestrationService({
      workspace,
      statePath: join(options.userDataPath, 'orchestration', `${workspace.id}.json`),
      worktreesRoot: join(options.userDataPath, 'worktrees'),
      launcher: delegate,
      roles: options.roles,
      exec,
      runChecks,
      fs,
      notifyChanged: options.notifyChanged,
      checkPolicy: options.checkPolicy,
      log: options.log,
    });
    services.set(workspace.id, service);
    return service;
  };

  const serviceFor = (workspaceId: string): OrchestrationService | undefined => {
    const existing = services.get(workspaceId);
    if (existing !== undefined) return existing;
    const workspace = options.listWorkspaces().find((candidate) => candidate.id === workspaceId);
    return workspace === undefined ? undefined : open(workspace);
  };

  const openAll = async (): Promise<void> => {
    await Promise.all(options.listWorkspaces().map((workspace) => open(workspace).ready));
  };

  return {
    setLauncher(next) {
      launcher = next;
    },
    serviceFor,
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
    async serviceForDispatch(dispatchId) {
      await openAll();
      return [...services.values()].find((service) => service.hasDispatch(dispatchId));
    },
    async flushAll() {
      await Promise.all([...services.values()].map((service) => service.flush()));
    },
  };
}
