import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function UsageActivityStrip({ hourly }: { hourly: number[] }) {
  const t = useT();
  const maximum = Math.max(0, ...hourly);
  const peak = hourly.indexOf(maximum);
  const hourLabel = (hour: number) => String(hour).padStart(2, '0');
  return (
    <section className="min-w-0 rounded-xl border bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-sm">{t('settings.usage.activity')}</h3>
        <p className="text-muted-foreground text-xs tabular-nums">
          {maximum > 0
            ? t('settings.usage.peakHour', {
                hour: hourLabel(peak),
                end: hourLabel((peak + 1) % 24),
              })
            : t('settings.usage.empty')}
        </p>
      </div>
      <div className="mt-3 grid h-8 grid-cols-24 items-end gap-1">
        {HOURS.map((hour) => {
          const count = hourly[hour] ?? 0;
          const label = t('settings.usage.hourCell', { hour: hourLabel(hour), count });
          return (
            <Tooltip key={hour}>
              <TooltipTrigger
                aria-label={label}
                className="flex h-full min-w-0 items-end outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className="w-full rounded-sm bg-sky-500/60 dark:bg-sky-400/60"
                  style={{
                    height: `${Math.max(8, (count / (maximum || 1)) * 100)}%`,
                    opacity: count ? 1 : 0.2,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </section>
  );
}
