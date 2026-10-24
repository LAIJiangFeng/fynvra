import type { Dispatch, Message, MessageType, TaskStatus } from '@fynvra/core';

// 编排面板的文案、配色与格式化。纯函数，不碰 DOM，可在 node 下测试。

/** 任务看板的分组顺序。 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  'todo',
  'in-progress',
  'in-review',
  'completed',
  'failed',
  'abandoned',
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待开始',
  'in-progress': '进行中',
  'in-review': '待验收',
  completed: '已完成',
  failed: '失败',
  abandoned: '已放弃',
};

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

export const MESSAGE_TYPE_LABEL: Record<MessageType, string> = {
  question: '提问',
  reply: '答复',
  instruction: '指示',
  worker_done: '完成汇报',
  escalation: '上报',
  heartbeat: '心跳',
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

const OUTCOME_LABEL: Record<string, string> = { succeeded: '成功', failed: '失败' };

/** worker_done 的 subject 是 outcome（追加汇报带 ` (follow-up)`）。 */
export function describeSubject(message: Message): string | undefined {
  if (!message.subject) return undefined;
  if (message.type !== 'worker_done') return message.subject;
  const followUp = message.subject.endsWith(' (follow-up)');
  const outcome = followUp ? message.subject.slice(0, -' (follow-up)'.length) : message.subject;
  const label = OUTCOME_LABEL[outcome] ?? outcome;
  return followUp ? `${label}（追加）` : label;
}

/** worker_done 的结果；不是汇报或认不出时为 undefined。 */
export function reportOutcome(message: Message): 'succeeded' | 'failed' | undefined {
  if (message.type !== 'worker_done' || !message.subject) return undefined;
  if (message.subject.startsWith('succeeded')) return 'succeeded';
  if (message.subject.startsWith('failed')) return 'failed';
  return undefined;
}

/** 卡片上的「最近消息」一行。 */
export function messageSummary(message: Message, max = 80): string {
  const subject = describeSubject(message);
  const head = subject
    ? `${MESSAGE_TYPE_LABEL[message.type]}·${subject}`
    : MESSAGE_TYPE_LABEL[message.type];
  return `${head}：${oneLine(message.body, max)}`;
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

/** `42 秒` / `3 分 12 秒` / `1 小时 5 分`。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
}

/** `刚刚` / `3 分钟前` / `2 小时前`；超过一天给日期时间。 */
export function formatRelative(epoch: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - epoch) / 1000);
  if (seconds < 45) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
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
