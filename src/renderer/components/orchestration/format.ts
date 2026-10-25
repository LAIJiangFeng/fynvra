import type { Dispatch, Message, MessageType, TaskStatus } from '@fynvra/core';
import type { T } from '../../i18n';

// 编排面板的配色与格式化（文案在字典 orchestration.* / time.*）。纯函数，不碰 DOM，可在 node 下测试。

/** 任务看板的分组顺序。 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  'todo',
  'in-progress',
  'in-review',
  'completed',
  'failed',
  'abandoned',
];

/** 状态色：圆点 / 卡片左边框 / 徽标。 */
export const TASK_STATUS_TONE: Record<TaskStatus, { dot: string; border: string; badge: string }> =
  {
    todo: {
      dot: 'bg-muted-foreground/50',
      border: 'border-l-muted-foreground/40',
      badge: 'bg-muted text-muted-foreground',
    },
    'in-progress': {
      dot: 'bg-sky-500',
      border: 'border-l-sky-500',
      badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    },
    'in-review': {
      dot: 'bg-amber-500',
      border: 'border-l-amber-500',
      badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    },
    completed: {
      dot: 'bg-emerald-500',
      border: 'border-l-emerald-500',
      badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    },
    failed: {
      dot: 'bg-destructive',
      border: 'border-l-destructive',
      badge: 'bg-destructive/15 text-destructive',
    },
    abandoned: {
      dot: 'bg-muted-foreground/30',
      border: 'border-l-muted-foreground/20',
      badge: 'bg-muted text-muted-foreground line-through',
    },
  };

/** worker → 主 agent 的类型；其余是主 agent → worker。 */
const WORKER_SENT: ReadonlySet<MessageType> = new Set([
  'question',
  'worker_done',
  'escalation',
  'heartbeat',
]);

/** 消息是不是 worker 发出的：优先看发送方，对不上时按类型判断。 */
export function isFromWorker(message: Message, dispatch: Dispatch | undefined): boolean {
  if (dispatch && message.from === dispatch.workerSessionId) return true;
  if (dispatch && message.to === dispatch.workerSessionId) return false;
  return WORKER_SENT.has(message.type);
}

/** worker_done 的 subject 是 outcome（追加汇报带 ` (follow-up)`）。 */
export function describeSubject(message: Message, t: T): string | undefined {
  if (!message.subject) return undefined;
  if (message.type !== 'worker_done') return message.subject;
  const followUp = message.subject.endsWith(' (follow-up)');
  const outcome = followUp ? message.subject.slice(0, -' (follow-up)'.length) : message.subject;
  const label =
    outcome === 'succeeded' || outcome === 'failed'
      ? t(`orchestration.outcome.${outcome}`)
      : outcome;
  return followUp ? t('orchestration.followUp', { outcome: label }) : label;
}

export function messageTypeLabel(type: MessageType, t: T): string {
  return t(`orchestration.messageTypes.${type}`);
}

export function taskStatusLabel(status: TaskStatus, t: T): string {
  return t(`orchestration.status.${status}`);
}

/** worker_done 的结果；不是汇报或认不出时为 undefined。 */
export function reportOutcome(message: Message): 'succeeded' | 'failed' | undefined {
  if (message.type !== 'worker_done' || !message.subject) return undefined;
  if (message.subject.startsWith('succeeded')) return 'succeeded';
  if (message.subject.startsWith('failed')) return 'failed';
  return undefined;
}

/** 卡片上的「最近消息」一行。 */
export function messageSummary(message: Message, t: T, max = 80): string {
  const subject = describeSubject(message, t);
  const type = messageTypeLabel(message.type, t);
  const head = subject ? t('orchestration.messageHead', { type, subject }) : type;
  return t('orchestration.messageLine', { head, body: oneLine(message.body, max) });
}

/** 折叠空白并截断到 `max` 个字符。 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 本地时间 `HH:MM:SS`；不是今天时加上 `MM-DD`。 */
export function formatClock(epoch: number, now: number = Date.now()): string {
  const date = new Date(epoch);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** `42 秒` / `3 分 12 秒` / `1 小时 5 分`（英文 `42s` / `3m 12s` / `1h 5m`）。 */
export function formatDuration(ms: number, t: T): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('time.seconds', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 === 0
      ? t('time.minutes', { m: minutes })
      : t('time.minutesSeconds', { m: minutes, s: seconds % 60 });
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0
    ? t('time.hours', { h: hours })
    : t('time.hoursMinutes', { h: hours, m: minutes % 60 });
}

/** `刚刚` / `3 分钟前` / `2 小时前`（按界面语言）；超过一天给日期时间。 */
export function formatRelative(epoch: number, now: number, t: T): string {
  const seconds = Math.floor((now - epoch) / 1000);
  if (seconds < 45) return t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  return formatClock(epoch, now);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** worker 输出投影（Main 的 Transcript）里一行的类别，决定着色。 */
export type OutputLineKind =
  | 'text'
  | 'user'
  | 'tool'
  | 'tool-done'
  | 'error'
  | 'notice'
  | 'settled';

export function outputLineKind(line: string): OutputLineKind {
  if (!line.startsWith('[')) return 'text';
  if (line.startsWith('[user]')) return 'user';
  if (line.startsWith('[tool error]') || line.startsWith('[error]')) return 'error';
  if (line.startsWith('[tool done]')) return 'tool-done';
  if (line.startsWith('[tool]')) return 'tool';
  if (line.startsWith('[approval]') || line.startsWith('[aborted]')) return 'notice';
  if (line.startsWith('[settled]')) return 'settled';
  return 'text';
}
