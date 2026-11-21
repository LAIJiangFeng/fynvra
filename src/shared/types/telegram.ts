// Telegram 群反馈值班的共享视图类型（ARCHITECTURE §7.14）；不含 token 明文，不 import Node / Electron。

/** 连接状态：未启用 / 没有 token / 连接中 / 已连接 / 网络错误 / token 无效 / 同一 token 另有实例在轮询 / 其他 API 错误 */
export type TelegramConnection =
  | 'disabled'
  | 'no-token'
  | 'connecting'
  | 'connected'
  | 'network-error'
  | 'unauthorized'
  | 'conflict'
  | 'api-error';

export type TelegramCardKind = 'bug' | 'feature' | 'question' | 'invalid';

/**
 * 卡片状态：
 * asking 追问中；answered 已回答的提问；invalid 无效；fixing 已投给值班会话修复；
 * pending-approval 待确认需求；declined 三问未过；rejected 用户拒绝；unconfirmed 未确认（问满或超时）；
 * pr-opened PR 已开；needs-maintainer 需要维护者处理；unreported 分诊这一轮没有调用 triage_report。
 */
export type TelegramCardStatus =
  | 'asking'
  | 'answered'
  | 'invalid'
  | 'fixing'
  | 'pending-approval'
  | 'declined'
  | 'rejected'
  | 'unconfirmed'
  | 'pr-opened'
  | 'needs-maintainer'
  | 'unreported';

export interface TelegramCardView {
  id: number;
  chatId: number;
  /** 来源群名（只在电脑上显示，PR 正文里不写） */
  groupTitle: string;
  workspaceId: string;
  kind?: TelegramCardKind;
  status: TelegramCardStatus;
  title: string;
  summary: string;
  evidence?: string;
  assessment?: string;
  /** 新功能的三问评估格式不完整 */
  assessmentIncomplete?: boolean;
  /** 已追问轮数（上限 2） */
  followUps: number;
  /** 关联的编排任务 id */
  taskIds: string[];
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramCandidateView {
  chatId: number;
  title: string;
  seenAt: number;
}

export interface TelegramGroupView {
  chatId: number;
  title: string;
  workspaceId: string;
  triageSessionId: string;
  /** 机器人被移出群后为 false，停止投递 */
  active: boolean;
}

export interface TelegramStateView {
  enabled: boolean;
  connection: TelegramConnection;
  /** token 的掩码（如 `123456:AB…yz`）；没有 token 时缺省 */
  tokenMasked?: string;
  bot?: { id: number; username: string };
  candidates: TelegramCandidateView[];
  groups: TelegramGroupView[];
  /** 新的在前 */
  cards: TelegramCardView[];
  /** 每人每小时最多处理几条 */
  rateLimitPerHour: number;
}

/** 每人每小时限额：默认 5，可配 1–1000 */
export const TELEGRAM_RATE_LIMIT_DEFAULT = 5;
export const TELEGRAM_RATE_LIMIT_MAX = 1000;

export function isTelegramRateLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= TELEGRAM_RATE_LIMIT_MAX
  );
}

export type TelegramCardAction = 'approve' | 'reject';

/** token 只给首尾几位：`123456:AB…yz`。 */
export function maskTelegramToken(token: string): string {
  const colon = token.indexOf(':');
  if (colon < 0 || token.length - colon < 6) return '…';
  return `${token.slice(0, colon + 3)}…${token.slice(-2)}`;
}
