import { isThemeMode, type ThemeMode } from '@shared/types/settings';
import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { useSettingsStore } from '@/stores/settings';

const THEME_OPTIONS: { value: ThemeMode; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

export function ThemeMenu() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const t = useT();
  const current = THEME_OPTIONS.find((option) => option.value === theme);
  const CurrentIcon = current?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('app.themeCurrent', {
                    theme: t(`app.themes.${current?.value ?? 'system'}`),
                  })}
                />
              }
            />
          }
        >
          <CurrentIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('app.theme')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isThemeMode(value)) setTheme(value);
          }}
        >
          <DropdownMenuLabel>{t('app.theme')}</DropdownMenuLabel>
          {/* Base UI 的单选项默认点选后不关菜单；主题选完即生效，直接关闭 */}
          {THEME_OPTIONS.map(({ value, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} closeOnClick>
              <Icon />
              {t(`app.themes.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
