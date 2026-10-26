import type { UsageDay } from '@shared/types/usage';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { formatCompact, formatCost } from './usageFormat';

const TOKEN_SERIES = [
  { key: 'outputTokens', color: 'bg-zinc-700 dark:bg-zinc-200' },
  { key: 'inputTokens', color: 'bg-zinc-400 dark:bg-zinc-500' },
  { key: 'cacheTokens', color: 'bg-zinc-200 dark:bg-zinc-700' },
] as const;

export function UsageDailyChart({ days }: { days: UsageDay[] }) {
  const t = useT();
  const [mode, setMode] = useState<'tokens' | 'cost'>('tokens');
  const maximum = Math.max(
    0,
    ...days.map((day) => (mode === 'tokens' ? day.totalTokens : day.cost))
  );
  const scale = maximum || 1;
  const format = mode === 'tokens' ? formatCompact : formatCost;
  const labelStep = days.length > 30 ? 7 : days.length > 7 ? 3 : 1;
  return (
    <section className="min-w-0 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium text-sm">{t('settings.usage.dailyTrend')}</h3>
        <fieldset
          className="flex rounded-lg bg-muted p-0.5"
          aria-label={t('settings.usage.dailyTrend')}
        >
          {(['tokens', 'cost'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              )}
            >
              {t(value === 'cost' ? 'settings.usage.costToggle' : 'settings.usage.tokens')}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="mt-4 flex min-h-5 flex-wrap items-center gap-4 text-muted-foreground text-xs">
        {mode === 'tokens' ? (
          TOKEN_SERIES.map(({ key, color }) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className={cn('size-2.5 rounded-sm', color)} />
              {t(`settings.usage.${key}`)}
            </span>
          ))
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-emerald-500" />
            {t('settings.usage.cost')}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {t('settings.usage.maximum', { value: format(maximum) })}
        </span>
      </div>
      <div className="mt-4 overflow-x-auto pb-1">
        <div
          className="grid gap-1"
          style={{
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            minWidth: days.length * 18,
          }}
        >
          {days.map((day, index) => {
            const details = [
              day.date,
              `${t('settings.usage.totalTokens')}: ${day.totalTokens.toLocaleString()}`,
              ...TOKEN_SERIES.map(
                ({ key }) => `${t(`settings.usage.${key}`)}: ${day[key].toLocaleString()}`
              ),
              `${t('settings.usage.cost')}: $${day.cost.toFixed(4)}`,
            ].join('\n');
            return (
              <div key={day.date} className="min-w-0">
                <Tooltip>
                  <TooltipTrigger
                    aria-label={details}
                    className="flex h-44 w-full items-end justify-center border-b outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex h-full w-full max-w-12 flex-col justify-end overflow-hidden rounded-t-sm">
                      {mode === 'tokens' ? (
                        TOKEN_SERIES.map(({ key, color }) => (
                          <span
                            key={key}
                            className={cn('w-full shrink-0', color)}
                            style={{ height: `${(day[key] / scale) * 100}%` }}
                          />
                        ))
                      ) : (
                        <span
                          className="w-full bg-emerald-500 dark:bg-emerald-400"
                          style={{ height: `${(day.cost / scale) * 100}%` }}
                        />
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="whitespace-pre-line tabular-nums">
                    {details}
                  </TooltipContent>
                </Tooltip>
                <div className="relative mt-2 h-4 text-center text-[10px] text-muted-foreground tabular-nums">
                  {(index % labelStep === 0 || index === days.length - 1) && (
                    <span
                      className={cn(
                        'absolute whitespace-nowrap',
                        days.length <= 7
                          ? 'left-1/2 -translate-x-1/2'
                          : index === 0
                            ? 'left-0'
                            : index === days.length - 1
                              ? 'right-0'
                              : 'left-1/2 -translate-x-1/2'
                      )}
                    >
                      {day.date.slice(5).replace('-', '/')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
