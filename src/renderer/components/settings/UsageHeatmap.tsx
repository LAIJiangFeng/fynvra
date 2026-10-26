import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const SHADES = [
  'bg-muted',
  'bg-emerald-100 dark:bg-emerald-950',
  'bg-emerald-300 dark:bg-emerald-800',
  'bg-emerald-500 dark:bg-emerald-600',
  'bg-emerald-700 dark:bg-emerald-400',
];

export function UsageHeatmap({ cells }: { cells: number[][] }) {
  const t = useT();
  const maximum = Math.max(1, ...cells.flat());
  return (
    <section className="min-w-0 rounded-xl border bg-card p-5">
      <h3 className="font-medium text-sm">{t('settings.usage.activity')}</h3>
      <div className="mt-4 overflow-x-auto pb-1">
        <div className="min-w-[520px]">
          <div className="mb-2 grid grid-cols-[3rem_1fr] gap-2">
            <span />
            <div className="grid grid-cols-24 gap-1 text-center text-[10px] text-muted-foreground tabular-nums">
              {HOURS.map((hour) => (
                <span key={hour}>
                  {hour % 3 === 0 || hour === 23 ? String(hour).padStart(2, '0') : ''}
                </span>
              ))}
            </div>
          </div>
          {WEEKDAYS.map((weekday, index) => (
            <div key={weekday} className="mb-1 grid grid-cols-[3rem_1fr] items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {t(`settings.usage.weekdays.${weekday}`)}
              </span>
              <div className="grid grid-cols-24 gap-1">
                {HOURS.map((hour) => {
                  const count = cells[index]?.[hour] ?? 0;
                  const shade = count === 0 ? 0 : Math.max(1, Math.ceil((count / maximum) * 4));
                  const label = t('settings.usage.cell', {
                    day: t(`settings.usage.weekdays.${weekday}`),
                    hour: String(hour).padStart(2, '0'),
                    count,
                  });
                  return (
                    <Tooltip key={hour}>
                      <TooltipTrigger
                        aria-label={label}
                        className={cn(
                          'aspect-square max-h-7 w-full rounded-sm outline-none hover:ring-1 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring',
                          SHADES[shade]
                        )}
                      />
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 text-muted-foreground text-xs">
        <span className="mr-1">{t('settings.usage.less')}</span>
        {SHADES.map((shade) => (
          <span key={shade} className={cn('size-3 rounded-sm', shade)} />
        ))}
        <span className="ml-1">{t('settings.usage.more')}</span>
      </div>
    </section>
  );
}
