import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import { parseWorkspaceId, type Workspace } from '@shared/types/workspace';
import { app, ipcMain } from 'electron';
import {
  createOrchestrationRegistry,
  type OrchestrationRegistry,
} from '../services/orchestration/registry';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getRoleStore } from './roles';
import { getSettingsFile } from './settings';
import { getWorkspaceService } from './workspaces';

let registry: OrchestrationRegistry | null = null;

/** 已挂入的工作区（含 repoPath）；只在 Main 内使用。 */
function listWorkspaces(): Workspace[] {
  const workspaces = getWorkspaceService();
  return workspaces.list().flatMap((summary) => workspaces.get(summary.id) ?? []);
}

/**
 * Main 内共享的编排注册表（每个工作区一个 OrchestrationService）；userData 在启动早期才确定，延迟创建。
 * 角色与 roles IPC、agent host 共用 {@link getRoleStore} 单例。
 * agent-host 的接线见 `src/main/services/orchestration/README.md`。
 */
export function getOrchestrationRegistry(): OrchestrationRegistry {
  if (registry === null) {
    registry = createOrchestrationRegistry({
      userDataPath: app.getPath('userData'),
      listWorkspaces,
      roles: getRoleStore(),
      worktreesRoot: () => getSettingsFile().read().preferences.worktreesRoot,
      notifyChanged: (workspaceId) =>
        sendToAllWindows(IPC_CHANNELS.ORCHESTRATION_CHANGED, workspaceId),
    });
  }
  return registry;
}

// dispatch id 由 @fynvra/core 的 newId('dispatch') 生成，是不透明 token
const DISPATCH_ID_PATTERN = /^dispatch_[a-z0-9]{1,64}$/;

function parseDispatchId(raw: unknown): string | null {
  return typeof raw === 'string' && DISPATCH_ID_PATTERN.test(raw) ? raw : null;
}

function parseOutputRequest(raw: unknown): { dispatchId: string; cursor: number } | null {
  const record = asRecord(raw);
  const dispatchId = parseDispatchId(record?.dispatchId);
  const cursor = record?.cursor;
  if (dispatchId === null || typeof cursor !== 'number') return null;
  return Number.isSafeInteger(cursor) && cursor >= 0 ? { dispatchId, cursor } : null;
}

export function registerOrchestrationHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ORCHESTRATION_SNAPSHOT,
    async (_event, raw: unknown): Promise<IpcResult<OrchestrationSnapshotView>> => {
      const workspaceId = parseWorkspaceId(raw);
      if (!workspaceId) return { ok: false, error: '无效的工作区 id' };
      try {
        const service = getOrchestrationRegistry().serviceFor(workspaceId);
        if (!service) return { ok: false, error: '工作区不存在' };
        return { ok: true, ...(await service.snapshot()) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  // 与 read_worker_output 同源；Renderer 只传 dispatch id 与 cursor
  ipcMain.handle(
    IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT,
    async (
      _event,
      raw: unknown
    ): Promise<IpcResult<{ text: string; total: number; done: boolean }>> => {
      const input = parseOutputRequest(raw);
      if (!input) return { ok: false, error: '无效的 dispatch id 或 cursor' };
      try {
        const service = await getOrchestrationRegistry().serviceForDispatch(input.dispatchId);
        if (!service) return { ok: false, error: 'dispatch 不存在' };
        return await service.readWorkerOutput(input);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF,
    async (
      _event,
      raw: unknown
    ): Promise<
      IpcResult<{ branch: string; baseCommit: string; files: string[]; stat: string; diff: string }>
    > => {
      const dispatchId = parseDispatchId(raw);
      if (!dispatchId) return { ok: false, error: '无效的 dispatch id' };
      try {
        const service = await getOrchestrationRegistry().serviceForDispatch(dispatchId);
        if (!service) return { ok: false, error: 'dispatch 不存在' };
        return await service.reviewDiff(dispatchId);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
