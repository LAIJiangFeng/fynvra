import { USAGE_RANGES, type UsageRange, type UsageSummary } from '@shared/types/usage';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { getUsageApi } from '@/lib/api/usage';
import { cn } from '@/lib/utils';
import { InlineMessage } from './common';
import { UsageActivityStrip } from './UsageActivityStrip';
import {
  UsageCache,
  UsageModels,
  UsageOrchestrationCard,
  UsageRoles,
  UsageWorkspaces,
} from './UsageBreakdowns';
import { UsageDailyChart } from './UsageDailyChart';
import { formatChange, formatCompact, formatCost, formatDuration } from './usageFormat';

function UsageHero({ summary }: { summary: UsageSummary }) {
  const t = useT();
  const { current, previous } = summary;
  return (
    <section className="min-w-0 rounded-xl border bg-card p-5">
      <p className="text-muted-foreground text-xs">{t('settings.usage.overview')}</p>
      <div className="mt-4 flex flex-wrap gap-x-10 gap-y-5">
        {(['cost', 'totalTokens'] as const).map((key) => {
          const format = key === 'cost' ? formatCost : formatCompact;
          return (
            <div key={key}>
              <p className="text-muted-foreground text-xs">{t(`settings.usage.${key}`)}</p>
              <p
                className={cn(
                  'mt-1 font-semibold text-4xl tabular-nums tracking-tight',
                  key === 'cost' && 'text-emerald-600 dark:text-emerald-400'
                )}
                title={String(current.totals[key])}
              >
                {format(current.totals[key])}
              </p>
              <p
                className="mt-2 text-[11px] text-muted-foreground"
                title={t('settings.usage.previousValue', { value: format(previous.totals[key]) })}
              >
                <span className="font-medium text-foreground tabular-nums">
                  {formatChange(current.totals[key], previous.totals[key])}
                </span>{' '}
                {t('settings.usage.vsPrevious')}
              </p>
            </div>
          );
        })}
      </div>
      <dl className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t pt-4 text-xs">
        {(['activeMs', 'sessions', 'messages'] as const).map((key) => (
          <div key={key} className="flex gap-2">
            <dt className="text-muted-foreground">{t(`settings.usage.${key}`)}</dt>
            <dd className="tabular-nums">
              {key === 'activeMs'
                ? formatDuration(current.totals[key])
                : formatCompact(current.totals[key])}
            </dd>
          </div>
        ))}
      </dl>
      {current.totals.messages === 0 && (
        <p className="mt-3 text-muted-foreground text-xs">{t('settings.usage.empty')}</p>
      )}
    </section>
  );
}

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
    <div className="@container grid gap-5" aria-busy={loading}>
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
          <div className="grid items-start gap-4 @min-[48rem]:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
            <div className="grid min-w-0 gap-4">
              <UsageHero summary={visible} />
              <UsageDailyChart
                days={visible.current.daily}
                today={visible.current.daily.at(-1)?.date ?? ''}
              />
            </div>
            <div className="grid min-w-0 gap-4">
              <UsageRoles roles={visible.byRole} />
              <UsageCache rate={visible.cacheHitRate} />
            </div>
          </div>
          <UsageActivityStrip hourly={visible.hourly} />
          <div className="grid items-start gap-4 @min-[48rem]:grid-cols-2">
            <UsageModels models={visible.byModel} />
            <UsageOrchestrationCard stats={visible.orchestration} />
            <UsageWorkspaces workspaces={visible.byWorkspace} />
          </div>
        </>
      )}
    </div>
  );
}
