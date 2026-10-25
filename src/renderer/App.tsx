import { MainArea } from '@/components/layout/MainArea';
import { NoticeDialog } from '@/components/layout/NoticeDialog';
import { Sidebar } from '@/components/layout/Sidebar';
import { SidePanel } from '@/components/layout/SidePanel';
import { TitleBar } from '@/components/layout/TitleBar';
import { UpdateBanner } from '@/components/layout/UpdateBanner';
import { SettingsView } from '@/components/settings/SettingsView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeybindingProvider } from '@/lib/keybindings';
import { bindFileUnloadGuard } from '@/stores/files';
import { useSettingsStore } from '@/stores/settings';
import { useUpdatesStore } from '@/stores/useUpdates';

/** 应用壳：自绘标题栏 + 三栏（工作区 / 会话侧栏、主区域、可折叠右侧面板）。 */
export function App() {
  const sidePanelOpen = useSettingsStore((state) => state.sidePanelOpen);
  useEffect(() => bindFileUnloadGuard(window), []);
  useEffect(() => useUpdatesStore.getState().bind(), []);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <UpdateBanner />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <MainArea />
          {sidePanelOpen && <SidePanel />}
        </div>
      </div>
      <NoticeDialog />
      <SettingsView />
      <KeybindingProvider />
    </TooltipProvider>
  );
}

import { useEffect } from 'react';
