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
  }
) {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date(timestamp).toISOString(),
    message: { role, timestamp, usage },
  });
}

function file(...lines: string[]) {
  const accumulator = createFileAccumulator();
  for (const value of lines) accumulator.add(value);
  return accumulator.finish();
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
      inputTokens: 300,
      outputTokens: 60,
      cacheTokens: 105,
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
    expect(summary.current.heatmap[5][9]).toBe(5);
    expect(summary.current.heatmap[5][14]).toBe(1);
    expect(summary.current.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(6);
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
      outputTokens: 0,
      cacheTokens: 4,
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
    expect(summary.current.heatmap[3][0]).toBe(1);
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
      expect(summary.current.heatmap).toHaveLength(7);
      expect(
        summary.current.heatmap.every((row) => row.length === 24 && row.every((cell) => cell === 0))
      ).toBe(true);
    }
  );

  it('keeps local calendar boundaries over daylight saving transitions', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const now = new Date(2026, 2, 8, 12).getTime();
    const summary = aggregateUsage([], 'today', now);
    expect(summary.current.end - summary.current.start).toBe(23 * 60 * 60_000);
    expect(summary.previous.end - summary.previous.start).toBe(24 * 60 * 60_000);
    expect(summary.current.daily[0].date).toBe('2026-03-08');
  });
});
