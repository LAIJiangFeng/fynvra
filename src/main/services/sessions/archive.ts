import { errorMessage } from '@shared/guards';
import type { SessionSummary } from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { isBusyStatus } from './archiveSweeper';
import { type SessionStore, type StoredSession, toSummary } from './sessionStore';

/** 清理 worktree 的结果：没删时带原因（没合并、不干净等），删失败时带错误 */
export interface WorktreeCleanupOutcome {
  removed: boolean;
  reason?: string;
  error?: string;
}

export interface SessionArchiveDeps {
  store: SessionStore;
  /** 让会话退出 agent worker（释放 pi 会话与 MCP 连接），下次使用时按记录重新创建 */
  dispose(sessionId: string): Promise<void>;
  /** 「通用 → 会话 → 归档时清理 worktree」，每次归档时现读 */
  cleanupWorktreeOnArchive(): boolean;
  /** 清理会话绑定的 worktree：只删已合并且干净的（生产为 OrchestrationService.cleanupMergedWorktree） */
  cleanupWorktree(session: StoredSession): Promise<WorktreeCleanupOutcome>;
  /** 会话列表变了：广播 sessions:changed */
  changed(workspaceId: string): void;
  now?(): number;
  log?(message: string): void;
}

export interface SessionArchive {
  /** 归档：运行中拒绝；已归档的原样返回 */
  archive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 恢复：闲置计时从现在重新开始；没归档的原样返回 */
  unarchive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
}

const BUSY = '会话正在运行，结束后再归档';

/**
 * 会话的归档与恢复（sessions:archive / unarchive 与闲置扫描共用）。只改注册表里的 archivedAt：
 * 归档不算一次更新（最后更新时间不变），恢复算（闲置扫描不会马上又把它归档）。
 */
export function createSessionArchive(deps: SessionArchiveDeps): SessionArchive {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[sessions] ${message}`));

  async function cleanup(session: StoredSession): Promise<void> {
    try {
      const outcome = await deps.cleanupWorktree(session);
      if (outcome.error) log(`清理会话 ${session.id} 的 worktree 失败：${outcome.error}`);
    } catch (error) {
      log(`清理会话 ${session.id} 的 worktree 失败：${errorMessage(error)}`);
    }
  }

  return {
    async archive(sessionId) {
      const stored = deps.store.get(sessionId);
      if (!stored) return { ok: false, error: '会话不存在' };
      if (stored.archivedAt !== undefined) return { ok: true, session: toSummary(stored) };
      if (isBusyStatus(stored.status)) return { ok: false, error: BUSY };
      const archived = deps.store.update(sessionId, { archivedAt: now() }) ?? stored;
      deps.changed(stored.workspaceId);
      try {
        await deps.dispose(sessionId);
      } catch (error) {
        log(`会话 ${sessionId} 退出 agent worker 失败：${errorMessage(error)}`);
      }
      if (archived.worktreeId !== undefined && deps.cleanupWorktreeOnArchive()) {
        await cleanup(archived);
      }
      return { ok: true, session: toSummary(archived) };
    },

    async unarchive(sessionId) {
      const stored = deps.store.get(sessionId);
      if (!stored) return { ok: false, error: '会话不存在' };
      if (stored.archivedAt === undefined) return { ok: true, session: toSummary(stored) };
      const restored =
        deps.store.update(sessionId, { archivedAt: undefined, updatedAt: now() }) ?? stored;
      deps.changed(stored.workspaceId);
      return { ok: true, session: toSummary(restored) };
    },
  };
}
