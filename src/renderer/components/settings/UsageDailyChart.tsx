import type { UsageDay } from '@shared/types/usage';
import { useId, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { formatCompact, formatCost } from './usageFormat';

const MODES = ['totalTokens', 'cost', 'sessions'] as const;
const WIDTH = 640;
const BASELINE = 164;

export function UsageDailyChart({ days, today }: { days: UsageDay[]; today: string }) {
  const t = useT();
  const gradient = useId();
  const [mode, setMode] = useState<(typeof MODES)[number]>('totalTokens');
  const [active, setActive] = useState<number | null>(null);
  const maximum = Math.max(0, ...days.map((day) => day[mode]));
  const format = mode === 'cost' ? formatCost : formatCompact;
  const points = days.map((day, index) => ({
    x: ((index + 0.5) / days.length) * WIDTH,
    y: BASELINE - (day[mode] / (maximum || 1)) * 146,
  }));
  const line = points
    .map((point, index) => {
      if (index === 0) return `M ${point.x} ${point.y}`;
      const previous = points[index - 1];
      const middle = (previous.x + point.x) / 2;
      return `C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
    })
    .join(' ');
  const first = points[0];
  const last = points.at(-1);
  const area = first && last ? `${line} L ${last.x} ${BASELINE} L ${first.x} ${BASELINE} Z` : '';
  const todayIndex = days.findIndex((day) => day.date === today);
  const highlighted = active ?? todayIndex;
  return (
    <section className="min-w-0 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium text-sm">{t('settings.usage.dailyTrend')}</h3>
        <fieldset
          className="flex rounded-lg bg-muted p-0.5"
          aria-label={t('settings.usage.dailyTrend')}
        >
          {MODES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              )}
            >
              {t(
                `settings.usage.${value === 'totalTokens' ? 'tokens' : value === 'cost' ? 'costToggle' : 'sessions'}`
              )}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="mt-4 flex justify-between gap-2 text-muted-foreground text-xs tabular-nums">
        <span>
          {maximum === 0
            ? t('settings.usage.emptyTrend')
            : t('settings.usage.maximum', { value: format(maximum) })}
        </span>
        <span>{t('settings.usage.todayMarker')}</span>
      </div>
      <div
        className={cn(
          'relative mt-2 h-44',
          mode === 'cost'
            ? 'text-emerald-500 dark:text-emerald-400'
            : 'text-sky-500 dark:text-sky-400'
        )}
      >
        <svg
          viewBox={`0 0 ${WIDTH} 176`}
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[18, 91, BASELINE].map((y) => (
            <line
              key={y}
              x1="0"
              x2={WIDTH}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeDasharray="3 5"
            />
          ))}
          {todayIndex >= 0 && (
            <line
              x1={points[todayIndex].x}
              x2={points[todayIndex].x}
              y1="4"
              y2={BASELINE}
              stroke="currentColor"
              strokeOpacity="0.4"
              strokeDasharray="3 4"
            />
          )}
          <path d={area} fill={`url(#${gradient})`} />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {highlighted >= 0 && points[highlighted] && (
            <circle
              cx={points[highlighted].x}
              cy={points[highlighted].y}
              r="3.5"
              fill="currentColor"
            />
          )}
        </svg>
        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        >
          {days.map((day, index) => {
            const details = `${day.date}${day.date === today ? ` · ${t('settings.usage.ranges.today')}` : ''}\n${t('settings.usage.totalTokens')}: ${day.totalTokens.toLocaleString()}\n${t('settings.usage.cost')}: $${day.cost.toFixed(4)}\n${t('settings.usage.sessions')}: ${day.sessions}`;
            return (
              <Tooltip key={day.date}>
                <TooltipTrigger
                  aria-label={details}
                  onMouseEnter={() => setActive(index)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  className="h-full min-w-0 outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring"
                />
                <TooltipContent className="whitespace-pre-line tabular-nums">
                  {details}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        {[...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
          .filter((index) => days[index])
          .map((index) => (
            <span
              key={days[index].date}
              className={cn(days[index].date === today && 'font-medium text-foreground')}
            >
              {days[index].date.slice(5).replace('-', '/')}
            </span>
          ))}
      </div>
    </section>
  );
}
