import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { SettingsButton } from '@/components/settings/SettingsButton';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ShortcutHint } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { selectSelectedWorkspace, useWorkspacesStore } from '@/stores/workspaces';
import { ThemeMenu } from './ThemeMenu';
import { WindowControls } from './WindowControls';

const isMac = window.fynvra.window.platform === 'darwin';

/**
 * 自绘标题栏：整条可拖动窗口，按钮区 no-drag。
 * macOS 左侧给系统红绿灯留位；其余平台在右侧自绘窗口按钮。
 */
export function TitleBar() {
  const sidePanelOpen = useSettingsStore((state) => state.sidePanelOpen);
  const toggleSidePanel = useSettingsStore((state) => state.toggleSidePanel);
  const workspaceName = useWorkspacesStore((state) => selectSelectedWorkspace(state)?.name);
  const panelLabel = sidePanelOpen ? '收起右侧面板' : '展开右侧面板';

  return (
    <header
      className={cn(
        'drag-region flex h-10 shrink-0 select-none items-center border-b bg-sidebar',
        isMac ? 'pl-20' : 'pl-4'
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="font-semibold">Fynvra</span>
        {workspaceName && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="truncate text-muted-foreground">{workspaceName}</span>
          </>
        )}
      </div>

      <div className="no-drag ml-auto flex items-center gap-1 px-2">
        <SettingsButton />
        <ThemeMenu />
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={panelLabel} />}
            onClick={toggleSidePanel}
          >
            {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {panelLabel}
            <ShortcutHint action="toggle-side-panel" />
          </TooltipContent>
        </Tooltip>
      </div>

      {!isMac && <WindowControls />}
    </header>
  );
}
