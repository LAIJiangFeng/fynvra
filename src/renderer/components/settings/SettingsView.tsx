import {
  Boxes,
  type LucideIcon,
  Palette,
  Plug,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  X,
} from 'lucide-react';
import { type ComponentType, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { AppearanceSettings } from './AppearanceSettings';
import { GeneralSettings } from './GeneralSettings';
import { McpSettings } from './McpSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { RolesSettings } from './RolesSettings';
import { SkillsSettings } from './SkillsSettings';
import { isSettingsSection, type SettingsSection, useSettingsViewStore } from './settingsViewStore';

/** 页头只有页名，不加副标题 */
interface SectionSpec {
  value: SettingsSection;
  label: string;
  icon: LucideIcon;
  Component: ComponentType;
  /** 双栏内容（角色编辑器）用更宽的版心 */
  wide?: boolean;
}

const SECTIONS: SectionSpec[] = [
  { value: 'general', label: '通用', icon: SlidersHorizontal, Component: GeneralSettings },
  { value: 'providers', label: '模型服务', icon: Boxes, Component: ProvidersSettings },
  { value: 'roles', label: '角色', icon: UserCog, Component: RolesSettings, wide: true },
  { value: 'skills', label: '技能', icon: Sparkles, Component: SkillsSettings },
  { value: 'mcp', label: 'MCP', icon: Plug, Component: McpSettings },
  { value: 'appearance', label: '外观', icon: Palette, Component: AppearanceSettings },
];

/**
 * 设置视图：主窗口内、标题栏下方的整页视图（不是独立窗口）。
 * 标题栏保持可用：设置按钮、窗口按钮和拖动区域都在。关闭时整个视图卸载，各页的未保存状态随之丢弃。
 */
export function SettingsView() {
  const open = useSettingsViewStore((state) => state.open);
  return open ? <SettingsPanel /> : null;
}

function SettingsPanel() {
  const section = useSettingsViewStore((state) => state.section);
  const setSection = useSettingsViewStore((state) => state.setSection);
  const close = useSettingsViewStore((state) => state.close);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = SECTIONS.find((item) => item.value === section) ?? SECTIONS[0];

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      tabIndex={-1}
      className="fixed inset-x-0 top-10 bottom-0 z-40 flex bg-background outline-none"
      onKeyDown={(event) => {
        // 弹窗、下拉经 Portal 渲染在视图之外：它们自己处理 Esc，不应连带关闭设置
        if (event.key === 'Escape' && containerRef.current?.contains(event.target as Node)) {
          close();
        }
      }}
    >
      <Tabs
        orientation="vertical"
        value={current?.value}
        onValueChange={(value) => {
          if (isSettingsSection(value)) setSection(value);
        }}
        className="flex min-w-0 flex-1 gap-0"
      >
        <nav className="flex w-52 shrink-0 flex-col border-r bg-sidebar p-2 text-sidebar-foreground">
          <p className="px-2 pt-1 pb-2 font-medium text-muted-foreground text-xs">设置</p>
          <TabsList className="w-full gap-0.5 bg-transparent p-0">
            {SECTIONS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-8 w-full flex-none justify-start gap-2 px-2 font-normal text-sidebar-foreground hover:bg-sidebar-accent data-[active]:bg-sidebar-accent data-[active]:font-medium data-[active]:text-sidebar-accent-foreground data-[active]:shadow-none dark:text-sidebar-foreground dark:data-[active]:border-transparent dark:data-[active]:bg-sidebar-accent"
              >
                <Icon className="text-muted-foreground" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
            <h2 className="min-w-0 flex-1 truncate font-semibold leading-tight">
              {current?.label}
            </h2>
            <Button variant="ghost" size="icon-sm" aria-label="关闭设置" onClick={close}>
              <X />
            </Button>
          </header>
          <ScrollArea className="flex-1">
            {SECTIONS.map(({ value, Component, wide }) => (
              <TabsContent
                key={value}
                value={value}
                className={cn('mx-auto w-full px-6 py-6', wide ? 'max-w-5xl' : 'max-w-3xl')}
              >
                <Component />
              </TabsContent>
            ))}
          </ScrollArea>
        </div>
      </Tabs>
    </div>
  );
}
