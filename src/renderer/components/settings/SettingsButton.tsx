import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { ShortcutHint } from '@/lib/keybindings';
import { useSettingsViewStore } from './settingsViewStore';

/** 标题栏上的设置入口：开 / 关主窗口内的设置视图。 */
export function SettingsButton() {
  const open = useSettingsViewStore((state) => state.open);
  const toggle = useSettingsViewStore((state) => state.toggle);
  const t = useT();
  const label = t(open ? 'app.closeSettings' : 'app.openSettings');

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={open} />}
        onClick={toggle}
      >
        <Settings />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {!open && <ShortcutHint action="open-settings" />}
      </TooltipContent>
    </Tooltip>
  );
}
