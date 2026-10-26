import type { UsagePeriod, UsageTotals } from '@shared/types/usage';
import type { UsageApi } from '../../../preload/domains/usage';
import type { FynvraApi } from '../../../preload/types';

export function getUsageApi(): UsageApi {
  return (globalThis as { fynvra?: Partial<FynvraApi> }).fynvra?.usage ?? mockUsageApi;
}

/** Browser preview only; real desktop data always comes from Main. */
const mockUsageApi: UsageApi = {
  async summary({ range }) {
    const now = new Date();
    const days = range === 'today' ? 1 : Number.parseInt(range, 10);
    return {
      ok: true,
      summary: {
        range,
        generatedAt: now.getTime(),
        current: mockPeriod(now, days, 0),
        previous: mockPeriod(now, days, days),
      },
    };
  },
};

function mockPeriod(now: Date, days: number, offset: number): UsagePeriod {
  const midnight = (delta: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
  const totals: UsageTotals = {
    cost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    activeMs: 0,
    sessions: 0,
    messages: 0,
  };
  const period: UsagePeriod = {
    start: midnight(1 - offset - days).getTime(),
    end: midnight(1 - offset).getTime(),
    totals,
    daily: [],
    heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
  };
  for (let index = 0; index < days; index += 1) {
    const date = midnight(1 - offset - days + index);
    const scale = (date.getDate() % 5) + 1;
    const daily = {
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      inputTokens: 1370 * scale,
      outputTokens: 830 * scale,
      cacheTokens: 2400 * scale,
      totalTokens: 4600 * scale,
      cost: 0.012 * scale,
      activeMs: 6 * 60_000 * scale,
      sessions: scale,
      messages: 16 * scale,
    };
    period.daily.push(daily);
    for (const key of Object.keys(totals) as (keyof UsageTotals)[]) totals[key] += daily[key];
    for (const hour of [9, 10, 14, 16]) period.heatmap[date.getDay()][hour] += 4 * scale;
  }
  return period;
}
