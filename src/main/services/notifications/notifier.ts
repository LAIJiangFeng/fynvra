import type { Message } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { ApprovalRequest, SessionEventEnvelope } from '@shared/types/chat';
import type { NotificationPreferences } from '@shared/types/settings';
import { createCoalescer } from './coalesce';
import {
  allowedBy,
  compactionWarningCandidate,
  createTurnTracker,
  hiddenByView,
  messageCandidate,
  type NotificationCandidate,
  type NotifiedSession,
  toolNoticeCandidate,
  type ViewState,
} from './rules';

/** 普通通知启动静默；实时工具操作通知不受限，不重放历史审批。 */
export const STARTUP_QUIET_MS = 5_000;
/** 同一会话同类通知合并窗口；只影响提示频率，不影响工具执行。 */
export const COALESCE_MS = 2_000;

/** 交给系统弹出的一条通知 */
export interface DesktopNotification {
  title: string;
  body: string;
  /** 不放提示音 */
  silent: boolean;
  /** 点击后切到的会话；测试通知没有 */
  target?: { sessionId: string; workspaceId: string };
}

export interface NotifierDeps {
  /** 当前生效的通知设置，每次现读：改了立即生效 */
  preferences(): NotificationPreferences;
  /** 窗口是否聚焦、正看着哪个会话 */
  view(): ViewState;
  /** 会话 id → 通知用到的字段；会话不存在时 undefined */
  session(sessionId: string): NotifiedSession | undefined;
  show(notification: DesktopNotification): void;
  now?(): number;
  log?(message: string): void;
}

export interface Notifier {
  /** agent host 推给 Renderer 的会话事件 */
  sessionEvent(envelope: SessionEventEnvelope): void;
  /** @deprecated 旧审批请求忽略，不产生通知或执行许可。 */
  approvalRequest(request: ApprovalRequest): void;
  /** 收件箱新投递的消息 */
  message(message: Message): void;
  /** 丢掉还没弹的通知并释放去重记录（退出时） */
  clear(): void;
}

/** 回合跟踪只看这几种；其余（流式片段、工具调用）不查会话 */
const TRACKED_EVENTS = new Set(['message_end', 'error', 'agent_settled']);

/**
 * 普通事件 → 桌面通知：启动静默期内丢掉，按开关筛一遍进合并窗口
 * （同一会话 {@link COALESCE_MS} 内只留最后一条）；窗口结束时按当时的设置与窗口状态决定弹不弹。
 * 实时工具操作与 Magic Context 回退告警不受启动静默限制，按会话 seq 去重并独立合并，不等待点击或任何答复。
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[notifications] ${message}`));
  const quietUntil = now() + STARTUP_QUIET_MS;
  const turns = createTurnTracker();
  // Main 提供跨 generation 单调递增的会话 seq，只保留有界的最近记录。
  const noticedSeq = new Map<string, number>();
  const coalescer = createCoalescer<NotificationCandidate>({ windowMs: COALESCE_MS, emit: show });

  function claimSeq(sessionId: string, seq: number): boolean {
    if (seq <= (noticedSeq.get(sessionId) ?? 0)) return false;
    noticedSeq.delete(sessionId);
    noticedSeq.set(sessionId, seq);
    if (noticedSeq.size > 1_000) {
      const oldest = noticedSeq.keys().next().value;
      if (oldest !== undefined) noticedSeq.delete(oldest);
    }
    return true;
  }

  function offer(candidate: NotificationCandidate | null): void {
    if (!candidate || now() < quietUntil) return;
    // 先按开关筛：被关掉的通知不能在合并窗口里顶替能弹的
    if (!allowedBy(deps.preferences(), candidate.kind)) return;
    coalescer.push(candidate.sessionId, candidate);
  }

  function show(candidate: NotificationCandidate): void {
    try {
      // 弹出时现读设置；包括读取设置 / 窗口状态在内的失败都只影响通知。
      const preferences = deps.preferences();
      if (!allowedBy(preferences, candidate.kind) || hiddenByView(candidate, deps.view())) return;
      const { title, body, sessionId, workspaceId } = candidate;
      deps.show({ title, body, silent: !preferences.sound, target: { sessionId, workspaceId } });
    } catch (error) {
      log(`弹出通知失败：${errorMessage(error)}`);
    }
  }

  return {
    sessionEvent({ sessionId, event }) {
      if (event.type === 'tool_notice') {
        if (!claimSeq(sessionId, event.seq)) return;
        const session = deps.session(sessionId);
        if (!session || !allowedBy(deps.preferences(), 'tool-notice')) return;
        coalescer.push(`tool:${sessionId}`, toolNoticeCandidate(session, event));
        return;
      }
      if (event.type === 'warning' && event.source === 'magic-context') {
        // 独立于工具执行通知；按会话 seq 去重并与自身窗口合并。
        if (!claimSeq(sessionId, event.seq)) return;
        const session = deps.session(sessionId);
        if (!session || !allowedBy(deps.preferences(), 'compaction-warning')) return;
        coalescer.push(`compaction:${sessionId}`, compactionWarningCandidate(session));
        return;
      }
      if (!TRACKED_EVENTS.has(event.type)) return;
      const session = deps.session(sessionId);
      if (session) offer(turns.push(session, event));
    },
    approvalRequest() {
      // 历史审批不是新的操作通知，不重新展示或等待用户。
    },
    message(message) {
      offer(messageCandidate(message, deps.session));
    },
    clear() {
      coalescer.clear();
      noticedSeq.clear();
    },
  };
}
