import type { IpcResult } from './ipc';

export const USAGE_RANGES = ['today', '7d', '30d', '90d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageTotals {
  cost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
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
  /** Message counts: weekday (Sunday first) × hour. */
  heatmap: number[][];
}

export interface UsageSummary {
  range: UsageRange;
  generatedAt: number;
  current: UsagePeriod;
  previous: UsagePeriod;
}

export type UsageSummaryResult = IpcResult<{ summary: UsageSummary }>;
