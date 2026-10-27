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
    const current = mockPeriod(now, days, 0);
    const { totalTokens, cost, sessions, messages } = current.totals;
    const workerSessions = Math.floor(sessions * 0.7);
    const modelTokens = Math.floor(totalTokens * 0.65);
    const hourly = Array<number>(24).fill(0);
    hourly[9] = Math.floor(messages * 0.2);
    hourly[10] = Math.floor(messages * 0.25);
    hourly[14] = Math.floor(messages * 0.35);
    hourly[16] = messages - hourly[9] - hourly[10] - hourly[14];
    const completed = days * 2;
    return {
      ok: true,
      summary: {
        range,
        generatedAt: now.getTime(),
        current,
        previous: mockPeriod(now, days, days),
        byRole: [
          {
            roleId: 'worker',
            totalTokens: totalTokens * 0.7,
            cost: cost * 0.7,
            sessions: workerSessions,
          },
          {
            roleId: 'orchestrator',
            totalTokens: totalTokens * 0.3,
            cost: cost * 0.3,
            sessions: sessions - workerSessions,
          },
        ],
        byModel: [
          {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            totalTokens: modelTokens,
            cost: cost * 0.8,
            share: modelTokens / totalTokens,
          },
          {
            provider: 'openai',
            model: 'gpt-5.4',
            totalTokens: totalTokens - modelTokens,
            cost: cost * 0.2,
            share: (totalTokens - modelTokens) / totalTokens,
          },
        ],
        byWorkspace: [
          {
            workspaceId: 'preview-app',
            name: 'Fynvra',
            totalTokens: totalTokens * 0.8,
            cost: cost * 0.8,
          },
          {
            workspaceId: 'preview-docs',
            name: 'Documentation',
            totalTokens: totalTokens * 0.2,
            cost: cost * 0.2,
          },
        ],
        orchestration: {
          dispatched: completed + 2,
          completed,
          abandoned: 1,
          failed: 1,
          rejected: days,
          firstPassRate: 0.5,
          averageAttempts: 1.5,
          workerCostPerMergedTask: (cost * 0.6) / completed,
        },
        hourly,
        cacheHitRate: 0.72,
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
    activeMs: 0,
    sessions: 0,
    messages: 0,
  };
  const period: UsagePeriod = {
    start: midnight(1 - offset - days).getTime(),
    end: midnight(1 - offset).getTime(),
    totals,
    daily: [],
  };
  for (let index = 0; index < days; index += 1) {
    const date = midnight(1 - offset - days + index);
    const scale = (date.getDate() % 5) + 1;
    const daily = {
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      totalTokens: 46000 * scale,
      cost: 0.12 * scale,
      activeMs: 6 * 60_000 * scale,
      sessions: scale,
      messages: 16 * scale,
    };
    period.daily.push(daily);
    for (const key of Object.keys(totals) as (keyof UsageTotals)[]) totals[key] += daily[key];
  }
  return period;
}
