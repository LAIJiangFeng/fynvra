import type { Message } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { ApprovalRequest, SessionEventEnvelope } from '@shared/types/chat';
import type { NotificationPreferences } from '@shared/types/settings';
import { createCoalescer } from './coalesce';
import {
  allowedBy,
  approvalCandidate,
  createTurnTracker,
  hiddenByView,
  messageCandidate,
  type NotificationCandidate,
  type NotifiedSession,
  type ViewState,
} from './rules';

/** 启动后多久内不弹：恢复会话、worker 重启补发的事件不该一下子弹一串 */
export const STARTUP_QUIET_MS = 5_000;
/** 同一会话多久内的多条合并为最后一条 */
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
  /** 审批门的请求 */
  approvalRequest(request: ApprovalRequest): void;
  /** 收件箱新投递的消息 */
  message(message: Message): void;
  /** 丢掉还没弹的（退出时） */
  clear(): void;
}

/** 回合跟踪只看这几种；其余（流式片段、工具调用）不查会话 */
const TRACKED_EVENTS = new Set(['message_end', 'error', 'agent_settled']);

/**
 * 事件 → 桌面通知：先按规则得出候选，启动静默期内的丢掉，再按开关筛一遍进合并窗口
 * （同一会话 {@link COALESCE_MS} 内只留最后一条）；窗口结束时按当时的设置与窗口状态决定弹不弹。
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[notifications] ${message}`));
  const quietUntil = now() + STARTUP_QUIET_MS;
  const turns = createTurnTracker();
  const coalescer = createCoalescer<NotificationCandidate>({ windowMs: COALESCE_MS, emit: show });

  function offer(candidate: NotificationCandidate | null): void {
    if (!candidate || now() < quietUntil) return;
    // 先按开关筛：被关掉的通知不能在合并窗口里顶替能弹的
    if (!allowedBy(deps.preferences(), candidate.kind)) return;
    coalescer.push(candidate.sessionId, candidate);
  }

  function show(candidate: NotificationCandidate): void {
    // 窗口期间可能改了设置，或用户已经切过去看着了
    const preferences = deps.preferences();
    if (!allowedBy(preferences, candidate.kind) || hiddenByView(candidate, deps.view())) return;
    const { title, body, sessionId, workspaceId } = candidate;
    try {
      deps.show({ title, body, silent: !preferences.sound, target: { sessionId, workspaceId } });
    } catch (error) {
      log(`弹出通知失败：${errorMessage(error)}`);
    }
  }

  return {
    sessionEvent({ sessionId, event }) {
      if (!TRACKED_EVENTS.has(event.type)) return;
      const session = deps.session(sessionId);
      if (session) offer(turns.push(session, event));
    },
    approvalRequest(request) {
      const session = deps.session(request.sessionId);
      if (session) offer(approvalCandidate(session, request));
    },
    message(message) {
      offer(messageCandidate(message, deps.session));
    },
    clear() {
      coalescer.clear();
    },
  };
}
