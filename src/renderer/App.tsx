import { sidebarOpenOf } from '@shared/types/settings';
import { MainArea } from '@/components/layout/MainArea';
import { NoticeDialog } from '@/components/layout/NoticeDialog';
import { Sidebar } from '@/components/layout/Sidebar';
import { SidePanel } from '@/components/layout/SidePanel';
import { TitleBar } from '@/components/layout/TitleBar';
import { UpdateBanner } from '@/components/layout/UpdateBanner';
import { SettingsView } from '@/components/settings/SettingsView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionsWorkspaceSync } from '@/hooks/useSessionsWorkspaceSync';
import { KeybindingProvider } from '@/lib/keybindings';
import { bindFileUnloadGuard } from '@/stores/files';
import { useSettingsStore } from '@/stores/settings';
import { useUpdatesStore } from '@/stores/useUpdates';

/** 应用壳：自绘标题栏 + 三栏（可收起的工作区 / 会话侧栏、主区域、可折叠右侧面板）。 */
export function App() {
  const sidePanelOpen = useSettingsStore((state) => state.sidePanelOpen);
  const sidebarOpen = useSettingsStore(sidebarOpenOf);
  // 左栏收起时不挂载：选中的工作区照样同步给会话 store
  useSessionsWorkspaceSync();
  useEffect(() => bindFileUnloadGuard(window), []);
  useEffect(() => useUpdatesStore.getState().bind(), []);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <UpdateBanner />
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && <Sidebar />}
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
