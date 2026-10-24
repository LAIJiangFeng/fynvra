import type { ThemeMode } from '@shared/types/settings';
import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { SectionHeader } from './common';

const THEMES: { value: ThemeMode; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

/** 外观：与标题栏的主题菜单共用 settings store，两处始终一致。 */
export function AppearanceSettings() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);

  return (
    <section>
      <SectionHeader title="主题" description="浅色、深色，或跟随系统的明暗设置。" />
      <div className="grid grid-cols-3 gap-3">
        {THEMES.map(({ value, label, icon: Icon }) => (
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
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
