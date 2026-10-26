const UNITS = ['', 'K', 'M', 'B', 'T'];

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1000 && unit < UNITS.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  // Avoid rounding 999.99K to 1000K.
  if (unit > 0 && Number(amount.toFixed(1)) >= 1000 && unit < UNITS.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const number = unit === 0 ? Math.round(amount) : Number(amount.toFixed(1));
  return `${value < 0 ? '-' : ''}${number}${UNITS[unit]}`;
}

export function formatCost(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '—';
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatChange(current: number, previous: number): string {
  if (previous <= 0 || !Number.isFinite(current) || !Number.isFinite(previous)) return '—';
  const percent = Math.round(((current - previous) / previous) * 1000) / 10;
  return `${percent > 0 ? '+' : ''}${percent}%`;
}
