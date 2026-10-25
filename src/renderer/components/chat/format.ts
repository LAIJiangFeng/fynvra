import type { T } from '../../i18n';

// 时间线、状态栏、会话列表共用的展示格式（纯函数）

/** 耗时：850ms、1.2s、12s、1m 05s */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** token 数：980、1.2k、12k、1.2M */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${trimZero((count / 1_000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

/** 费用（美元）：$3.40、$0.12；不足一美分时保留两位有效数字，$0.0042 */
export function formatCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd <= 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toPrecision(2).replace(/0+$/, '')}`;
}

/** 列表里的「最近更新」：刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 10-24 / 2025-10-24（按界面语言） */
export function formatRelativeTime(timestamp: number, now: number, t: T): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { count: Math.floor(diff / 60_000) });
  const then = new Date(timestamp);
  const today = new Date(now);
  if (diff < 86_400_000 && then.getDate() === today.getDate()) {
    return t('time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  }
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(then, yesterday)) return t('time.yesterday');
  const monthDay = `${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
  return then.getFullYear() === today.getFullYear()
    ? monthDay
    : `${then.getFullYear()}-${monthDay}`;
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
