import { asRecord } from '@shared/guards';
import type {
  UsageAmount,
  UsageDay,
  UsageModel,
  UsagePeriod,
  UsageRange,
  UsageRole,
  UsageSummary,
  UsageTotals,
  UsageWorkspace,
} from '@shared/types/usage';
import type { StoredSession } from '../sessions/sessionStore';
import { aggregateOrchestration, type UsageSnapshot } from './orchestration';

interface UsageMessage extends UsageAmount {
  timestamp: number;
  inputTokens: number;
  cacheRead: number;
  model: { provider: string | null; model: string | null } | null;
}

interface FileDay {
  date: string;
  totals: UsageTotals;
  inputTokens: number;
  cacheRead: number;
  hours: number[];
  models: Omit<UsageModel, 'share'>[];
}

/** Cached data never includes message text, tools, or credentials. */
export interface FileUsage {
  days: FileDay[];
  spans: { start: number; end: number }[];
}

export interface SessionUsage extends FileUsage {
  sessionId: string;
}

export type UsageSession = Pick<StoredSession, 'id' | 'roleId' | 'workspaceId' | 'dispatchId'>;
export interface UsageContext {
  sessions: readonly UsageSession[];
  workspaces: readonly { id: string; name: string }[];
  snapshots: readonly UsageSnapshot[];
}

export function emptyTotals(): UsageTotals {
  return { cost: 0, totalTokens: 0, activeMs: 0, sessions: 0, messages: 0 };
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

function modelName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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
    const inputTokens = positiveNumber(usage?.input);
    const cacheRead = positiveNumber(usage?.cacheRead);
    return {
      timestamp,
      inputTokens,
      cacheRead,
      totalTokens:
        inputTokens + positiveNumber(usage?.output) + cacheRead + positiveNumber(usage?.cacheWrite),
      cost: positiveNumber(asRecord(usage?.cost)?.total),
      model:
        message.role === 'assistant'
          ? { provider: modelName(message.provider), model: modelName(message.model) }
          : null,
    };
  } catch {
    return null;
  }
}

function addAmount(target: UsageAmount, source: UsageAmount): void {
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
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
          totals: { ...emptyTotals(), sessions: 1 },
          inputTokens: 0,
          cacheRead: 0,
          hours: Array(24).fill(0),
          models: [],
        };
        days.set(key, day);
      }
      day.totals.messages += 1;
      addAmount(day.totals, message);
      day.inputTokens += message.inputTokens;
      day.cacheRead += message.cacheRead;
      day.hours[date.getHours()] += 1;
      if (message.model && (message.totalTokens > 0 || message.cost > 0)) {
        let model = day.models.find(
          (item) => item.provider === message.model?.provider && item.model === message.model.model
        );
        if (!model) {
          model = { ...message.model, totalTokens: 0, cost: 0 };
          day.models.push(model);
        }
        addAmount(model, message);
      }
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
  for (const file of files) {
    let hasMessages = false;
    for (const day of file.days) {
      const bucket = daily.get(day.date);
      if (!bucket) continue;
      hasMessages = true;
      addTotals(bucket, day.totals);
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
  return { start, end, totals, daily: [...daily.values()] };
}

function rank<T extends UsageAmount>(values: Iterable<T>): T[] {
  return [...values].sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost);
}

export function aggregateUsage(
  files: readonly SessionUsage[],
  range: UsageRange,
  now: number,
  context: UsageContext = { sessions: [], workspaces: [], snapshots: [] }
): UsageSummary {
  const length = range === 'today' ? 1 : Number.parseInt(range, 10);
  const today = new Date(now);
  const end = midnightOffset(today, 1);
  const start = midnightOffset(today, 1 - length);
  const current = aggregatePeriod(files, start, end);
  const dates = new Set(current.daily.map((day) => day.date));
  const sessions = new Map(context.sessions.map((session) => [session.id, session]));
  const workspaces = new Map(context.workspaces.map((workspace) => [workspace.id, workspace]));
  const roles = new Map<string | null, UsageRole>();
  const models = new Map<string, UsageModel>();
  const workspaceUsage = new Map<string | null, UsageWorkspace>();
  const hourly: number[] = Array(24).fill(0);
  let input = 0;
  let cacheRead = 0;
  for (const file of files) {
    const days = file.days.filter((day) => dates.has(day.date));
    if (!days.length) continue;
    const session = sessions.get(file.sessionId);
    const roleId = session?.roleId ?? null;
    const role = roles.get(roleId) ?? { roleId, sessions: 0, totalTokens: 0, cost: 0 };
    roles.set(roleId, role);
    role.sessions += 1;
    const workspace = session && workspaces.get(session.workspaceId);
    const workspaceId = workspace?.id ?? null;
    const byWorkspace = workspaceUsage.get(workspaceId) ?? {
      workspaceId,
      name: workspace?.name ?? null,
      totalTokens: 0,
      cost: 0,
    };
    workspaceUsage.set(workspaceId, byWorkspace);
    for (const day of days) {
      addAmount(role, day.totals);
      addAmount(byWorkspace, day.totals);
      input += day.inputTokens;
      cacheRead += day.cacheRead;
      for (let hour = 0; hour < 24; hour += 1) hourly[hour] += day.hours[hour];
      for (const item of day.models) {
        const key = JSON.stringify([item.provider, item.model]);
        const model = models.get(key) ?? {
          provider: item.provider,
          model: item.model,
          totalTokens: 0,
          cost: 0,
          share: 0,
        };
        addAmount(model, item);
        models.set(key, model);
      }
    }
  }
  for (const model of models.values()) {
    model.share = current.totals.totalTokens ? model.totalTokens / current.totals.totalTokens : 0;
  }
  return {
    range,
    generatedAt: now,
    current,
    previous: aggregatePeriod(files, midnightOffset(today, 1 - 2 * length), start),
    byRole: rank(roles.values()),
    byModel: rank(models.values()),
    byWorkspace: rank(workspaceUsage.values()),
    orchestration: aggregateOrchestration(context.snapshots, files, sessions, start, end),
    hourly,
    cacheHitRate: input + cacheRead ? cacheRead / (input + cacheRead) : null,
  };
}
