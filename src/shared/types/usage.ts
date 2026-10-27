import type { IpcResult } from './ipc';

export const USAGE_RANGES = ['today', '7d', '30d', '90d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageTotals {
  cost: number;
  totalTokens: number;
  activeMs: number;
  sessions: number;
  messages: number;
}

export interface UsageDay extends UsageTotals {
  /** Local calendar date, YYYY-MM-DD (not UTC). */
  date: string;
}

export interface UsagePeriod {
  /** Epoch milliseconds; inclusive start, exclusive end. */
  start: number;
  end: number;
  totals: UsageTotals;
  daily: UsageDay[];
}

export interface UsageAmount {
  totalTokens: number;
  cost: number;
}

export interface UsageRole extends UsageAmount {
  /** null means the session is no longer in the registry. */
  roleId: string | null;
  sessions: number;
}

export interface UsageModel extends UsageAmount {
  provider: string | null;
  model: string | null;
  /** Fraction of the current period's tokens. */
  share: number;
}

export interface UsageWorkspace extends UsageAmount {
  workspaceId: string | null;
  /** Display name only, never a filesystem path. */
  name: string | null;
}

/** Current outcomes of tasks first dispatched in the selected period, not merge events. */
export interface UsageOrchestration {
  dispatched: number;
  completed: number;
  abandoned: number;
  failed: number;
  /** Later attempts started within the period, including tasks first dispatched earlier. */
  rejected: number;
  /** Omitted when no tasks in the cohort have completed. */
  firstPassRate?: number;
  averageAttempts?: number;
  /** Lifetime worker cost for the completed cohort / completed tasks; omitted if links are missing. */
  workerCostPerMergedTask?: number;
}

export interface UsageSummary {
  range: UsageRange;
  generatedAt: number;
  current: UsagePeriod;
  previous: UsagePeriod;
  byRole: UsageRole[];
  /** Ranked by tokens, then cost. */
  byModel: UsageModel[];
  byWorkspace: UsageWorkspace[];
  orchestration: UsageOrchestration;
  /** Messages per local hour of day (0–23) across the current period. */
  hourly: number[];
  /** cacheRead / (input + cacheRead); null when there is no input. */
  cacheHitRate: number | null;
}

export type UsageSummaryResult = IpcResult<{ summary: UsageSummary }>;
