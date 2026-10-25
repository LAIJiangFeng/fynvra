import type { ThemeMode } from '@shared/types/settings';
import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { SectionHeader } from './common';

const THEMES: { value: ThemeMode; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

/** 外观：与标题栏的主题菜单共用 settings store，两处始终一致。 */
export function AppearanceSettings() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const t = useT();

  return (
    <section>
      <SectionHeader title={t('settings.appearance.theme')} />
      <div className="grid grid-cols-3 gap-3">
        {THEMES.map(({ value, icon: Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border p-4 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
              theme === value && 'border-primary bg-accent font-medium'
            )}
          >
            <Icon className="size-5" />
            {t(`app.themes.${value}`)}
          </button>
        ))}
      </div>
    </section>
  );
}
