/** 右栏：可折叠的侧面板占位（任务、Diff、worker 输出在 Wave 2 接入）。 */
export function SidePanel() {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center px-4 font-medium text-muted-foreground text-xs">
        侧面板
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
        任务、Diff 与 worker 输出将显示在这里
      </div>
    </aside>
  );
}
