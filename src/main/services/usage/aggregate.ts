import { asRecord } from '@shared/guards';
import type {
  UsageDay,
  UsagePeriod,
  UsageRange,
  UsageSummary,
  UsageTotals,
} from '@shared/types/usage';

interface UsageMessage {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
}

interface FileDay {
  date: string;
  weekday: number;
  totals: UsageTotals;
  hours: number[];
}

/** Cached data never includes message text, tools, or credentials. */
export interface FileUsage {
  days: FileDay[];
  spans: { start: number; end: number }[];
}

export function emptyTotals(): UsageTotals {
  return {
    cost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    activeMs: 0,
    sessions: 0,
    messages: 0,
  };
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timestampOf(value: unknown): number | null {
  const timestamp =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())
    ? timestamp
    : null;
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** All branches count: the work recorded in abandoned branches was still performed. */
export function parseUsageLine(line: string): UsageMessage | null {
  try {
    const entry = asRecord(JSON.parse(line));
    const message = entry?.type === 'message' ? asRecord(entry.message) : null;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
    const timestamp = timestampOf(message.timestamp) ?? timestampOf(entry?.timestamp);
    if (timestamp === null) return null;
    const usage = message.role === 'assistant' ? asRecord(message.usage) : null;
    return {
      timestamp,
      inputTokens: positiveNumber(usage?.input),
      outputTokens: positiveNumber(usage?.output),
      cacheTokens: positiveNumber(usage?.cacheRead) + positiveNumber(usage?.cacheWrite),
      cost: positiveNumber(asRecord(usage?.cost)?.total),
    };
  } catch {
    return null;
  }
}

/** Incrementally reduce lines, retaining only daily aggregates and timestamps for gap detection. */
export function createFileAccumulator() {
  const days = new Map<string, FileDay>();
  const timestamps: number[] = [];
  return {
    add(line: string): void {
      const message = parseUsageLine(line);
      if (!message) return;
      const date = new Date(message.timestamp);
      const key = localDateKey(date);
      let day = days.get(key);
      if (!day) {
        day = {
          date: key,
          weekday: date.getDay(),
          totals: emptyTotals(),
          hours: Array(24).fill(0),
        };
        day.totals.sessions = 1;
        days.set(key, day);
      }
      day.totals.messages += 1;
      day.totals.inputTokens += message.inputTokens;
      day.totals.outputTokens += message.outputTokens;
      day.totals.cacheTokens += message.cacheTokens;
      day.totals.totalTokens += message.inputTokens + message.outputTokens + message.cacheTokens;
      day.totals.cost += message.cost;
      day.hours[date.getHours()] += 1;
      timestamps.push(message.timestamp);
    },
    finish(): FileUsage {
      timestamps.sort((a, b) => a - b);
      const spans: FileUsage['spans'] = [];
      for (let index = 1; index < timestamps.length; index += 1) {
        const start = timestamps[index - 1];
        const end = timestamps[index];
        if (end > start && end - start <= 5 * 60_000) spans.push({ start, end });
      }
      return { days: [...days.values()], spans };
    },
  };
}

/** Local calendar arithmetic preserves day boundaries through daylight saving transitions. */
function midnightOffset(today: Date, days: number): number {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days).getTime();
}

const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof UsageTotals)[];

function addTotals(target: UsageTotals, source: UsageTotals): void {
  for (const key of TOTAL_KEYS) target[key] += source[key];
}

function aggregatePeriod(files: readonly FileUsage[], start: number, end: number): UsagePeriod {
  const daily = new Map<string, UsageDay>();
  for (let at = start; at < end; at = midnightOffset(new Date(at), 1)) {
    const date = localDateKey(new Date(at));
    daily.set(date, { date, ...emptyTotals() });
  }
  const totals = emptyTotals();
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const file of files) {
    let hasMessages = false;
    for (const day of file.days) {
      const bucket = daily.get(day.date);
      if (!bucket) continue;
      hasMessages = true;
      addTotals(bucket, day.totals);
      for (let hour = 0; hour < 24; hour += 1) heatmap[day.weekday][hour] += day.hours[hour];
    }
    if (hasMessages) totals.sessions += 1;
    for (const span of file.spans) {
      // Only spans whose two messages are in the requested period count.
      if (span.start < start || span.end >= end) continue;
      let at = span.start;
      while (at < span.end) {
        const date = new Date(at);
        const until = Math.min(span.end, midnightOffset(date, 1));
        const bucket = daily.get(localDateKey(date));
        if (bucket) bucket.activeMs += until - at;
        at = until;
      }
    }
  }
  const sessions = totals.sessions;
  for (const day of daily.values()) addTotals(totals, day);
  totals.sessions = sessions;
  return { start, end, totals, daily: [...daily.values()], heatmap };
}

export function aggregateUsage(
  files: readonly FileUsage[],
  range: UsageRange,
  now: number
): UsageSummary {
  const length = range === 'today' ? 1 : Number.parseInt(range, 10);
  const today = new Date(now);
  const end = midnightOffset(today, 1);
  const start = midnightOffset(today, 1 - length);
  return {
    range,
    generatedAt: now,
    current: aggregatePeriod(files, start, end),
    previous: aggregatePeriod(files, midnightOffset(today, 1 - 2 * length), start),
  };
}
