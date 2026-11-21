// 渠道宿主（ARCHITECTURE §7.12「渠道 API」）：把渠道值班依赖的核心能力按插件归属开放给渠道插件。
// 每个操作都先核对归属（会话 / 工作区 / 任务属于调用的插件），安全规则（档位、干净检出、出站过滤）由这里执行。
import { errorMessage } from '@shared/guards';
import type { HostCallResult } from '@shared/types/agent';
import type {
  ChannelFilterResult,
  ChannelProfile,
  ChannelSessionStatus,
  ChannelSnapshot,
} from '@shared/types/appPluginApi';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import type { Workspace } from '@shared/types/workspace';
import type { AgentHostService } from '../agentHost/agentHost';
import { type LocalInfoContext, sanitizeLocalInfo, scanSecrets } from '../secrets';
import type { CleanCheckout } from './cleanCheckout';
import type { ChannelStore } from './store';

/** 宿主调插件 channel.report 的超时 */
export const REPORT_TIMEOUT_MS = 30_000;

export interface ChannelHostDeps {
  store: ChannelStore;
  agentHost: Pick<AgentHostService, 'createProfileSession' | 'promptWhenIdle' | 'get' | 'observe'>;
  workspaces: { get(id: string): Workspace | undefined };
  snapshot(
    workspaceId: string
  ): Promise<Pick<OrchestrationSnapshotView, 'runs' | 'tasks'> | undefined>;
  cleanCheckout: CleanCheckout;
  /** 已知密钥（生产为 collectAppSecrets，含各插件登记的密钥） */
  knownSecrets(): Promise<readonly string[]>;
  localInfo(): Promise<LocalInfoContext>;
  /** 运行时：宿主调插件、向插件推事件 */
  call(pluginId: string, name: string, args: unknown): Promise<unknown>;
  emit(pluginId: string, event: string, payload: unknown): void;
  reportTimeoutMs?: number;
}

export interface ChannelHost {
  /** 读归属文件并订阅会话事件；返回取消订阅 */
  start(): Promise<() => void>;
  createSession(
    pluginId: string,
    input: { workspaceId: string; profile: ChannelProfile; title: string }
  ): Promise<{ sessionId: string }>;
  refreshCheckout(pluginId: string, workspaceId: string): Promise<void>;
  originCommit(pluginId: string, workspaceId: string): Promise<{ commit: string }>;
  prompt(pluginId: string, sessionId: string, text: string): Promise<{ delivered: boolean }>;
  sessionStatus(pluginId: string, sessionId: string): { status: ChannelSessionStatus };
  snapshot(pluginId: string, workspaceId: string): Promise<ChannelSnapshot>;
  filterOutbound(text: string): Promise<ChannelFilterResult>;
  setPullRequestNote(pluginId: string, taskId: string, text: string | null): Promise<void>;
  /** PR 正文组合用：该任务的插件 note */
  pullRequestNote(taskId: string): string | undefined;
  /** host-invoke 路由：会话归属某插件时调它的 channel.report；无归属返回 undefined（由调用方回退） */
  report(
    sessionId: string,
    method: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<HostCallResult> | undefined;
  /** 编排变化：只推给在该工作区有 run 的插件 */
  orchestrationChanged(workspaceId: string): void;
  removePlugin(pluginId: string): Promise<void>;
}

/** 插件 channel.report 的返回值收窄成 HostCallResult */
function toHostCallResult(raw: unknown): HostCallResult {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.ok === true) return { ...record, ok: true };
    if (record.ok === false && typeof record.error === 'string') {
      return { ok: false, error: record.error };
    }
  }
  return { ok: false, error: 'invalid channel.report result' };
}

export function createChannelHost(deps: ChannelHostDeps): ChannelHost {
  const { store, agentHost } = deps;
  const reportTimeoutMs = deps.reportTimeoutMs ?? REPORT_TIMEOUT_MS;
  /** 每个会话最近推送过的状态，只在变化时推 */
  const lastStatus = new Map<string, ChannelSessionStatus>();

  const localInfo = () => deps.localInfo().catch((): LocalInfoContext => ({ paths: [] }));
  /** 回给插件的错误文本先抹掉本机路径、用户名、主机名（git 报错里常带路径） */
  const fail = async (message: string): Promise<never> => {
    throw new Error(sanitizeLocalInfo(message, await localInfo()));
  };

  const statusOf = (sessionId: string): ChannelSessionStatus => {
    const session = agentHost.get(sessionId);
    if (!session) return 'missing';
    return session.archivedAt !== undefined ? 'archived' : session.status;
  };

  /** 只认本插件的会话；别人的与不存在的给同一个错误，不泄露存在性 */
  const ownSession = (pluginId: string, sessionId: string) => {
    const owner = store.ownerOf(sessionId);
    if (owner?.pluginId !== pluginId) throw new Error('session not found');
    return owner;
  };

  const ownedIds = (pluginId: string) =>
    new Set(store.sessionsOf(pluginId).map((owner) => owner.sessionId));

  /** 工作区须存在且有本插件的会话 */
  const ownWorkspace = (pluginId: string, workspaceId: string): Workspace => {
    const workspace = deps.workspaces.get(workspaceId);
    if (!workspace || !store.sessionsOf(pluginId).some((o) => o.workspaceId === workspaceId)) {
      throw new Error('workspace has no session of this plugin');
    }
    return workspace;
  };

  const pluginSnapshot = async (
    pluginId: string,
    workspaceId: string
  ): Promise<ChannelSnapshot> => {
    const owned = ownedIds(pluginId);
    const snapshot = owned.size > 0 ? await deps.snapshot(workspaceId) : undefined;
    if (!snapshot) return { runs: [], tasks: [] };
    const runs = snapshot.runs.filter((run) => owned.has(run.coordinatorSessionId));
    const runIds = new Set(runs.map((run) => run.id));
    return {
      runs: runs.map((run) => ({ id: run.id, coordinatorSessionId: run.coordinatorSessionId })),
      tasks: snapshot.tasks
        .filter((task) => runIds.has(task.runId))
        .map((task) => ({
          id: task.id,
          runId: task.runId,
          title: task.title,
          status: task.status,
          ...(task.pullRequest ? { pullRequest: { url: task.pullRequest.url } } : {}),
        })),
    };
  };

  const filterOutbound = async (text: string): Promise<ChannelFilterResult> => {
    const sanitized = sanitizeLocalInfo(text, await localInfo());
    let known: readonly string[] = [];
    try {
      known = await deps.knownSecrets();
    } catch (error) {
      // 读不到已知密钥时仍按通用模式扫描
      console.warn(`[channels] 读取已知密钥失败：${errorMessage(error)}`);
    }
    return scanSecrets(sanitized, known).hit
      ? { ok: false, reason: 'secret' }
      : { ok: true, text: sanitized };
  };

  const pushStatus = (sessionId: string) => {
    const owner = store.ownerOf(sessionId);
    if (!owner) return;
    // 状态在事件之后才落定：放到微任务里读
    queueMicrotask(() => {
      const status = statusOf(sessionId);
      if (lastStatus.get(sessionId) === status) return;
      lastStatus.set(sessionId, status);
      deps.emit(owner.pluginId, 'channel.session', { sessionId, status });
    });
  };

  return {
    async start() {
      await store.load();
      return agentHost.observe({
        event: ({ sessionId }) => pushStatus(sessionId),
        approval: (request) => pushStatus(request.sessionId),
        activity: (sessionId) => pushStatus(sessionId),
      });
    },
    async createSession(pluginId, { workspaceId, profile, title }) {
      const workspace = deps.workspaces.get(workspaceId);
      if (!workspace) throw new Error('workspace not found');
      if (workspace.vcs !== 'git') throw new Error('workspace is not a git repository');
      const ensured = await deps.cleanCheckout.ensure(workspace);
      if (!ensured.ok) return fail(`clean checkout failed: ${ensured.error}`);
      const created = await agentHost.createProfileSession({
        workspaceId,
        profile,
        cwd: ensured.path,
        title,
      });
      if (!created.ok) return fail(created.error);
      const sessionId = created.session.id;
      await store.addSession({ sessionId, pluginId, workspaceId });
      lastStatus.set(sessionId, statusOf(sessionId));
      return { sessionId };
    },
    async refreshCheckout(pluginId, workspaceId) {
      const workspace = ownWorkspace(pluginId, workspaceId);
      // 本插件在该工作区有会话在跑时不动它的工作目录
      const busy = store.sessionsOf(pluginId).some((owner) => {
        if (owner.workspaceId !== workspaceId) return false;
        const status = statusOf(owner.sessionId);
        return status === 'running' || status === 'waiting-approval';
      });
      if (busy) throw new Error('a session of this plugin is running in this workspace');
      const refreshed = await deps.cleanCheckout.refresh(workspace);
      if (!refreshed.ok) await fail(`refresh failed: ${refreshed.error}`);
    },
    async originCommit(pluginId, workspaceId) {
      const origin = await deps.cleanCheckout.originCommit(ownWorkspace(pluginId, workspaceId));
      return origin.ok ? { commit: origin.commit } : fail(origin.error);
    },
    async prompt(pluginId, sessionId, text) {
      ownSession(pluginId, sessionId);
      const sent = await agentHost.promptWhenIdle(sessionId, text);
      return sent.ok ? { delivered: sent.delivered } : fail(sent.error);
    },
    sessionStatus(pluginId, sessionId) {
      ownSession(pluginId, sessionId);
      return { status: statusOf(sessionId) };
    },
    snapshot: pluginSnapshot,
    filterOutbound,
    async setPullRequestNote(pluginId, taskId, text) {
      const workspaceIds = new Set(store.sessionsOf(pluginId).map((owner) => owner.workspaceId));
      let found = false;
      for (const workspaceId of workspaceIds) {
        const snapshot = await pluginSnapshot(pluginId, workspaceId);
        if (snapshot.tasks.some((task) => task.id === taskId)) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error('task not found');
      if (text === null) {
        await store.setNote(pluginId, taskId, null);
        return;
      }
      const filtered = await filterOutbound(text);
      if (!filtered.ok) throw new Error('note rejected: contains a secret');
      await store.setNote(pluginId, taskId, filtered.text);
    },
    pullRequestNote: (taskId) => store.noteOf(taskId)?.text,
    report(sessionId, method, input, signal) {
      const owner = store.ownerOf(sessionId);
      if (!owner) return undefined;
      return new Promise<HostCallResult>((resolve) => {
        const done = (result: HostCallResult) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = () => done({ ok: false, error: 'aborted' });
        const timer = setTimeout(
          () => done({ ok: false, error: 'channel.report timed out' }),
          reportTimeoutMs
        );
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
        deps
          .call(owner.pluginId, 'channel.report', { sessionId, method, input })
          .then(toHostCallResult, (error: unknown) => ({
            ok: false as const,
            error: errorMessage(error),
          }))
          .then(done);
      });
    },
    orchestrationChanged(workspaceId) {
      const plugins = new Set(store.sessionsIn(workspaceId).map((owner) => owner.pluginId));
      if (plugins.size === 0) return;
      void deps
        .snapshot(workspaceId)
        .then((snapshot) => {
          const coordinators = new Set(snapshot?.runs.map((run) => run.coordinatorSessionId));
          for (const pluginId of plugins) {
            const hasRun = store
              .sessionsOf(pluginId)
              .some((owner) => coordinators.has(owner.sessionId));
            if (hasRun) deps.emit(pluginId, 'channel.orchestrationChanged', { workspaceId });
          }
        })
        .catch((error: unknown) =>
          console.warn(`[channels] 读取编排快照失败：${errorMessage(error)}`)
        );
    },
    async removePlugin(pluginId) {
      for (const owner of store.sessionsOf(pluginId)) lastStatus.delete(owner.sessionId);
      await store.removePlugin(pluginId);
    },
  };
}
