import {
  USAGE_RANGES,
  type UsageRange,
  type UsageSummary,
  type UsageTotals,
} from '@shared/types/usage';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { getUsageApi } from '@/lib/api/usage';
import { cn } from '@/lib/utils';
import { InlineMessage } from './common';
import { UsageDailyChart } from './UsageDailyChart';
import { UsageHeatmap } from './UsageHeatmap';
import { formatChange, formatCompact, formatCost, formatDuration } from './usageFormat';

const METRICS: { key: keyof UsageTotals; format: (value: number) => string }[] = [
  { key: 'cost', format: formatCost },
  { key: 'totalTokens', format: formatCompact },
  { key: 'inputTokens', format: formatCompact },
  { key: 'outputTokens', format: formatCompact },
  { key: 'cacheTokens', format: formatCompact },
  { key: 'activeMs', format: formatDuration },
  { key: 'sessions', format: formatCompact },
  { key: 'messages', format: formatCompact },
];

export function UsageSettings() {
  const t = useT();
  const [request, setRequest] = useState<{ range: UsageRange }>({ range: '7d' });
  const { range } = request;
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    void getUsageApi()
      .summary(request)
      .then((result) => {
        if (canceled) return;
        if (result.ok) setSummary(result.summary);
        else setError(result.error);
      })
      .catch(() => {
        if (!canceled) setError(t('common.loadFailed'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [request, t]);

  const visible = summary?.range === range ? summary : null;
  return (
    <div className="grid gap-5" aria-busy={loading}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-muted-foreground text-sm leading-relaxed">
          {t('settings.usage.subtitle')}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => setRequest({ range })}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
          {t('settings.usage.refresh')}
        </Button>
      </div>
      <fieldset className="flex flex-wrap gap-2" aria-label={t('settings.usage.range')}>
        {USAGE_RANGES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={range === value}
            onClick={() => setRequest({ range: value })}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              range === value
                ? 'border-foreground bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {t(`settings.usage.ranges.${value}`)}
          </button>
        ))}
      </fieldset>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!visible && loading && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('common.loading')}
        </p>
      )}
      {visible && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {METRICS.map(({ key, format }) => {
              const current = visible.current.totals[key];
              const previous = visible.previous.totals[key];
              return (
                <div key={key} className="min-w-0 rounded-xl border bg-card p-4">
                  <p className="text-muted-foreground text-xs">{t(`settings.usage.${key}`)}</p>
                  <p
                    className={cn(
                      'mt-2 font-semibold text-2xl tabular-nums tracking-tight',
                      key === 'cost' && 'text-emerald-600 dark:text-emerald-400'
                    )}
                    title={String(current)}
                  >
                    {format(current)}
                  </p>
                  <p
                    className="mt-2 text-[11px] text-muted-foreground"
                    title={t('settings.usage.previousValue', { value: format(previous) })}
                  >
                    <span className="font-medium text-foreground tabular-nums">
                      {formatChange(current, previous)}
                    </span>{' '}
                    {t('settings.usage.vsPrevious')}
                  </p>
                </div>
              );
            })}
          </div>
          {visible.current.totals.messages === 0 && (
            <p className="text-muted-foreground text-sm">{t('settings.usage.empty')}</p>
          )}
          <UsageDailyChart days={visible.current.daily} />
          <UsageHeatmap cells={visible.current.heatmap} />
        </>
      )}
    </div>
  );
}
