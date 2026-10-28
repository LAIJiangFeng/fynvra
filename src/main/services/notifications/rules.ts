import type { FynvraSessionEventBody, Message, ToolOperationNotice } from '@fynvra/core';
import type { ApprovalRequest, SessionSummary } from '@shared/types/chat';
import type { NotificationPreferences } from '@shared/types/settings';
import { translate } from '../../i18n';

/**
 * 桌面通知的规则（纯函数，Task 24）：哪些事件弹、受哪个开关管、标题与正文怎么写、什么时候按聚焦抑制。
 * 弹不弹由 notifier 按设置判断；操作通知与普通通知均按会话节流。这里不碰 Electron。
 */

/** 正文取前多少字 */
export const EXCERPT_CHARS = 80;

export type NotificationKind =
  /** 主 agent（编排或用户直接对话的会话）一轮结束 */
  | 'turn-done'
  /** 主 agent 出错 */
  | 'turn-error'
  /** worker 汇报成功 */
  | 'worker-done'
  /** worker 汇报失败，或 worker 会话出错 */
  | 'worker-failed'
  /** worker 向主 agent 提问 */
  | 'question'
  /** 上报给主 agent（worker 或 Fynvra 自己） */
  | 'escalation'
  /** 单向工具操作通知，不等待确认 */
  | 'tool-notice'
  /** @deprecated 旧审批事件不再通知 */
  | 'approval';

/** 通知用到的会话字段；有 dispatchId 的是编排派出的 worker 会话 */
export type NotifiedSession = Pick<SessionSummary, 'id' | 'workspaceId' | 'title' | 'dispatchId'>;

export interface NotificationCandidate {
  kind: NotificationKind;
  /** 点击后切到的会话；普通通知的合并与聚焦抑制也按它 */
  sessionId: string;
  workspaceId: string;
  title: string;
  body: string;
}

export interface ViewState {
  /** 应用有窗口处于聚焦 */
  focused: boolean;
  /** 聚焦的窗口里正看着的会话 */
  viewingSessionId: string | null;
}

/** 设置允许弹这类通知吗（声音另算，窗口状态见 {@link hiddenByView}） */
export function allowedBy(preferences: NotificationPreferences, kind: NotificationKind): boolean {
  if (!preferences.enabled) return false;
  switch (kind) {
    case 'turn-done':
    case 'turn-error':
      return true;
    case 'worker-done':
    case 'worker-failed':
      return !preferences.mainAgentOnly;
    case 'question':
    case 'escalation':
    case 'tool-notice':
      return preferences.askAndApproval;
    case 'approval':
      return false;
  }
}

/** 普通通知在聚焦当前会话时不弹；操作通知可提醒，但不会抢焦点。 */
export function hiddenByView(candidate: NotificationCandidate, view: ViewState): boolean {
  return (
    candidate.kind !== 'tool-notice' && view.focused && view.viewingSessionId === candidate.sessionId
  );
}

/** 压成一行的纯文字，去掉常见的 Markdown 标记；超长时截成 `max` 字（含省略号），按字符计 */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const plain = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+)/, ''))
    .join(' ')
    .replace(/`+|\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : plain;
}

function candidate(
  kind: NotificationKind,
  session: NotifiedSession,
  title: string,
  body: string
): NotificationCandidate {
  return { kind, sessionId: session.id, workspaceId: session.workspaceId, title, body };
}

const isWorker = (session: NotifiedSession): boolean => session.dispatchId !== undefined;

export interface TurnTracker {
  /** 推一条会话事件；该弹通知时返回候选。只看 message_end / error / agent_settled */
  push(session: NotifiedSession, event: FynvraSessionEventBody): NotificationCandidate | null;
}

/**
 * 按会话跟踪一轮：记最后一条有文字的 assistant 消息，出错时立刻给出错通知，
 * 结束（agent_settled）时没出错、没中止才给完成通知。用户消息开启新一轮。
 * worker 会话的完成看收件箱里的 worker_done，这里只管它出错。
 */
export function createTurnTracker(): TurnTracker {
  const turns = new Map<string, { text: string; failed: boolean }>();
  const turnOf = (sessionId: string) => {
    let turn = turns.get(sessionId);
    if (!turn) {
      turn = { text: '', failed: false };
      turns.set(sessionId, turn);
    }
    return turn;
  };

  return {
    push(session, event) {
      switch (event.type) {
        case 'message_end':
          if (event.role === 'user') turns.delete(session.id);
          else if (event.text.trim()) turnOf(session.id).text = event.text;
          return null;
        case 'error': {
          turnOf(session.id).failed = true;
          const kind = isWorker(session) ? 'worker-failed' : 'turn-error';
          return candidate(
            kind,
            session,
            translate('notifications.errorTitle', { title: session.title }),
            excerpt(event.message)
          );
        }
        case 'agent_settled': {
          const turn = turns.get(session.id);
          turns.delete(session.id);
          if (event.aborted || turn?.failed || isWorker(session)) return null;
          return candidate(
            'turn-done',
            session,
            session.title,
            excerpt(turn?.text ?? '') || translate('notifications.done')
          );
        }
        default:
          return null;
      }
    },
  };
}

/** 操作通知仅含会话、固定工具标签与安全动作类别，不含参数或执行结果。 */
export function toolNoticeCandidate(
  session: NotifiedSession,
  notice: ToolOperationNotice
): NotificationCandidate {
  return candidate(
    'tool-notice',
    session,
    translate('notifications.operationTitle', { title: excerpt(session.title) }),
    translate('notifications.operationBody', {
      tool: notice.toolName,
      action: translate(`notifications.actions.${notice.kind}`),
    })
  );
}

/** @deprecated 仅保留旧调用方类型兼容，不由 notifier 发布。 */
export function approvalCandidate(
  session: NotifiedSession,
  _request: ApprovalRequest
): NotificationCandidate {
  return candidate('approval', session, session.title, '');
}

/**
 * 收件箱消息：worker_done（完成 / 失败）、question、escalation 弹，其余不弹。
 * 点开的是发送方会话（worker）；发送方不是会话（如 Fynvra 自己的上报）时是接收方（主 agent）。
 */
export function messageCandidate(
  message: Message,
  lookup: (sessionId: string) => NotifiedSession | undefined
): NotificationCandidate | null {
  const label = messageLabel(message);
  if (!label) return null;
  const session = lookup(message.from) ?? lookup(message.to);
  if (!session) return null;
  return candidate(
    label.kind,
    session,
    translate('notifications.labeledTitle', { title: session.title, label: label.text }),
    excerpt(message.body)
  );
}

function messageLabel(message: Message): { kind: NotificationKind; text: string } | null {
  switch (message.type) {
    case 'worker_done':
      // subject 是 outcome，追加汇报带 ` (follow-up)`
      return message.subject?.startsWith('failed')
        ? { kind: 'worker-failed', text: translate('notifications.failed') }
        : { kind: 'worker-done', text: translate('notifications.done') };
    case 'question':
      return { kind: 'question', text: translate('notifications.question') };
    case 'escalation':
      return { kind: 'escalation', text: translate('notifications.escalation') };
    default:
      return null;
  }
}
