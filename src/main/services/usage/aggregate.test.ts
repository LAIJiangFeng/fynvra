import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aggregateUsage, createFileAccumulator, parseUsageLine } from './aggregate';

function line(
  timestamp: number,
  role = 'assistant',
  usage: unknown = {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 5,
    totalTokens: 999,
    cost: { total: 0.025 },
  },
  model = { provider: 'provider-a', model: 'model-a' }
) {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date(timestamp).toISOString(),
    message: { role, timestamp, usage, ...model },
  });
}

let nextSession = 0;
function file(...lines: string[]) {
  const accumulator = createFileAccumulator();
  for (const value of lines) accumulator.add(value);
  return { ...accumulator.finish(), sessionId: `session-${nextSession++}` };
}

const at = (day: number, hour = 12, minute = 0) => new Date(2026, 3, day, hour, minute).getTime();

describe('usage aggregation', () => {
  beforeEach(() => vi.stubEnv('TZ', 'Asia/Shanghai'));
  afterEach(() => vi.unstubAllEnvs());

  it('counts user/assistant messages, all usage components and files, skipping malformed lines', () => {
    const first = file(
      line(at(3, 9, 0), 'user'),
      line(at(3, 9, 4)),
      line(at(3, 9, 9)),
      line(at(3, 9, 15)),
      line(at(3, 9, 16), 'user'),
      line(at(3, 9, 17), 'toolResult'),
      '',
      'broken json',
      'null',
      '[]',
      '{"type":"session"}',
      '{"type":"message","message":{"role":"assistant","timestamp":"invalid"}}'
    );
    const second = file(line(at(3, 14), 'user'));
    const summary = aggregateUsage([first, second], 'today', at(3, 18));
    expect(summary.current.totals).toEqual({
      cost: 0.07500000000000001,
      totalTokens: 465,
      activeMs: 10 * 60_000,
      sessions: 2,
      messages: 6,
    });
    expect(summary.current.daily).toHaveLength(1);
    expect(summary.current.daily[0]).toMatchObject({
      date: '2026-04-03',
      totalTokens: 465,
      sessions: 2,
    });
    expect(summary.hourly[9]).toBe(5);
    expect(summary.hourly[14]).toBe(1);
    expect(summary.hourly.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('uses local dates and entry timestamp fallback; validates numeric usage independently', () => {
    const raw = JSON.stringify({
      type: 'message',
      timestamp: '2026-03-31T16:02:00.000Z',
      message: {
        role: 'assistant',
        timestamp: 'bad',
        usage: { input: -1, output: '10', cacheRead: 4, cacheWrite: null, cost: { total: -2 } },
      },
    });
    expect(parseUsageLine(raw)).toMatchObject({
      inputTokens: 0,
      cacheRead: 4,
      totalTokens: 4,
      cost: 0,
    });
    expect(
      parseUsageLine('{"type":"message","message":{"role":"assistant","timestamp":1e300}}')
    ).toBeNull();
    const summary = aggregateUsage([file(raw)], '7d', at(3));
    expect(summary.current.daily.find((day) => day.date === '2026-04-01')).toMatchObject({
      messages: 1,
      totalTokens: 4,
    });
    expect(summary.hourly[0]).toBe(1);
  });

  it('compares contiguous equal calendar periods, counts each session once and fills empty days', () => {
    const summary = aggregateUsage(
      [
        file(
          line(at(3)),
          line(at(2)),
          line(at(-3)),
          line(at(-4)),
          line(at(-10)),
          line(at(-11)),
          line(at(4))
        ),
      ],
      '7d',
      at(3)
    );
    expect(summary.current.start).toBe(at(-3, 0));
    expect(summary.previous.start).toBe(at(-10, 0));
    expect(summary.previous.end).toBe(summary.current.start);
    expect(summary.current.end).toBe(at(4, 0));
    expect(summary.current.daily).toHaveLength(7);
    expect(summary.previous.daily).toHaveLength(7);
    expect(summary.current.totals).toMatchObject({ sessions: 1, messages: 3, totalTokens: 465 });
    expect(summary.previous.totals).toMatchObject({ sessions: 1, messages: 2, totalTokens: 310 });
    expect(summary.current.daily.filter((day) => day.messages === 0)).toHaveLength(4);
  });

  it('sorts message timestamps, splits short spans over midnight, and excludes spans across period boundaries', () => {
    const usage = file(line(at(3, 0, 2)), line(at(2, 23, 58)), line(at(2, 23, 57)));
    const week = aggregateUsage([usage], '7d', at(3));
    expect(week.current.totals.activeMs).toBe(5 * 60_000);
    expect(week.current.daily.find((day) => day.date === '2026-04-02')?.activeMs).toBe(3 * 60_000);
    expect(week.current.daily.find((day) => day.date === '2026-04-03')?.activeMs).toBe(2 * 60_000);
    const today = aggregateUsage([usage], 'today', at(3));
    expect(today.current.totals.activeMs).toBe(0);
    expect(today.previous.totals.activeMs).toBe(60_000);
  });

  it.each(['today', '7d', '30d', '90d'] as const)(
    'returns zero-filled %s periods for an empty library',
    (range) => {
      const summary = aggregateUsage([], range, at(3));
      expect(summary.current.daily).toHaveLength(
        range === 'today' ? 1 : Number.parseInt(range, 10)
      );
      expect(Object.values(summary.current.totals).every((value) => value === 0)).toBe(true);
      expect(summary.hourly).toEqual(Array(24).fill(0));
      expect(summary.cacheHitRate).toBeNull();
      expect(summary.byRole).toEqual([]);
      expect(summary.byModel).toEqual([]);
      expect(summary.byWorkspace).toEqual([]);
    }
  );

  it('joins current registry roles and workspace names, including custom and deleted sessions', () => {
    const files = [
      { ...file(line(at(2)), line(at(3))), sessionId: 'coord' },
      { ...file(line(at(3))), sessionId: 'worker' },
      { ...file(line(at(3))), sessionId: 'custom' },
      { ...file(line(at(3))), sessionId: 'deleted' },
      { ...file(line(at(-30))), sessionId: 'outside' },
    ];
    const context = {
      sessions: [
        { id: 'coord', roleId: 'orchestrator', workspaceId: 'app' },
        { id: 'worker', roleId: 'worker', workspaceId: 'app' },
        { id: 'custom', roleId: 'reviewer', workspaceId: 'docs' },
      ],
      workspaces: [
        { id: 'app', name: 'App' },
        { id: 'docs', name: 'Docs' },
      ],
      snapshots: [],
    };
    const summary = aggregateUsage(files, '7d', at(3), context);
    expect(summary.byRole).toEqual([
      { roleId: 'orchestrator', sessions: 1, totalTokens: 310, cost: 0.05 },
      { roleId: 'worker', sessions: 1, totalTokens: 155, cost: 0.025 },
      { roleId: 'reviewer', sessions: 1, totalTokens: 155, cost: 0.025 },
      { roleId: null, sessions: 1, totalTokens: 155, cost: 0.025 },
    ]);
    expect(summary.byWorkspace).toEqual([
      { workspaceId: 'app', name: 'App', totalTokens: 465, cost: 0.07500000000000001 },
      { workspaceId: 'docs', name: 'Docs', totalTokens: 155, cost: 0.025 },
      { workspaceId: null, name: null, totalTokens: 155, cost: 0.025 },
    ]);
    context.sessions[0].roleId = 'reviewer';
    context.workspaces[0].name = 'Renamed';
    const updated = aggregateUsage(files, '7d', at(3), context);
    expect(updated.byRole[0]).toMatchObject({ roleId: 'reviewer', sessions: 2, totalTokens: 465 });
    expect(updated.byWorkspace[0].name).toBe('Renamed');
  });

  it('ranks actual assistant models by tokens then cost, separates providers and filters dates', () => {
    const usage = (input: number, cost: number) => ({ input, cost: { total: cost } });
    const summary = aggregateUsage(
      [
        file(
          line(at(3), 'assistant', usage(100, 1)),
          line(at(3), 'assistant', usage(100, 1)),
          line(at(3), 'assistant', usage(300, 2), { provider: 'provider-a', model: 'model-b' }),
          line(at(3), 'assistant', usage(300, 3), { provider: 'provider-b', model: 'model-b' }),
          line(at(2), 'assistant', usage(9000, 9)),
          line(at(3), 'user', usage(9000, 9)),
          line(at(3), 'assistant', usage(200, 0), { provider: '', model: '' })
        ),
      ],
      'today',
      at(3)
    );
    expect(summary.byModel).toEqual([
      { provider: 'provider-b', model: 'model-b', totalTokens: 300, cost: 3, share: 0.3 },
      { provider: 'provider-a', model: 'model-b', totalTokens: 300, cost: 2, share: 0.3 },
      { provider: 'provider-a', model: 'model-a', totalTokens: 200, cost: 2, share: 0.2 },
      { provider: null, model: null, totalTokens: 200, cost: 0, share: 0.2 },
    ]);
  });

  it('weights cache reads across files and excludes writes/output, prior dates and tool messages', () => {
    const summary = aggregateUsage(
      [
        file(
          line(at(3), 'assistant', { input: 100, cacheRead: 300, cacheWrite: 900, output: 500 })
        ),
        file(line(at(3), 'assistant', { input: 100, cacheRead: 100 }), line(at(2))),
      ],
      'today',
      at(3)
    );
    expect(summary.cacheHitRate).toBeCloseTo(400 / 600);
    expect(aggregateUsage([file(line(at(3), 'user'))], 'today', at(3)).cacheHitRate).toBeNull();
    expect(
      aggregateUsage([file(line(at(3), 'assistant', { input: 100 }))], 'today', at(3)).cacheHitRate
    ).toBe(0);
  });

  it('combines local hours across days and files without including earlier periods', () => {
    const summary = aggregateUsage(
      [
        file(line(at(3, 9)), line(at(2, 9)), line(at(3, 23), 'user'), line(at(-10, 9))),
        file(line(at(1, 9)), line(at(3, 9), 'toolResult')),
      ],
      '7d',
      at(3)
    );
    expect(summary.hourly[9]).toBe(3);
    expect(summary.hourly[23]).toBe(1);
    expect(summary.hourly.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('keeps local calendar boundaries over daylight saving transitions', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const now = new Date(2026, 2, 8, 12).getTime();
    const summary = aggregateUsage([], 'today', now);
    expect(summary.current.end - summary.current.start).toBe(23 * 60 * 60_000);
    expect(summary.previous.end - summary.previous.start).toBe(24 * 60 * 60_000);
    expect(summary.current.daily[0].date).toBe('2026-03-08');
  });
});
