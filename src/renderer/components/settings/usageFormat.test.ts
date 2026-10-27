import { describe, expect, it } from 'vitest';
import { formatChange, formatCompact, formatCost, formatDuration } from './usageFormat';

describe('usage formatters', () => {
  it.each([
    [0, '0'],
    [123, '123'],
    [1000, '1K'],
    [91600, '91.6K'],
    [1200000, '1.2M'],
    [999999, '1M'],
    [2500000000, '2.5B'],
  ] as const)('formats compact counts %s', (input, output) => {
    expect(formatCompact(input)).toBe(output);
  });
  it('formats dollars and durations', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.1)).toBe('$0.10');
    expect(formatCost(1.239)).toBe('$1.24');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(59_999)).toBe('0m');
    expect(formatDuration(83 * 60_000)).toBe('1h 23m');
    expect(formatDuration(48 * 60 * 60_000)).toBe('48h 0m');
  });
  it('compares against a previous period, including zero and tiny changes', () => {
    expect(formatChange(10, 0)).toBe('—');
    expect(formatChange(0, 0)).toBe('—');
    expect(formatChange(150, 100)).toBe('+50%');
    expect(formatChange(1, 3)).toBe('-66.7%');
    expect(formatChange(0, 10)).toBe('-100%');
    expect(formatChange(100, 100)).toBe('0%');
    expect(formatChange(99.999, 100)).toBe('0%');
  });
  it('does not display invalid numeric values', () => {
    expect(formatCompact(NaN)).toBe('—');
    expect(formatCost(Infinity)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatChange(Infinity, 2)).toBe('—');
  });
});
