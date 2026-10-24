import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { cn } from '@/lib/utils';

/** 折叠区；展开状态在 Root 上（`open` / `defaultOpen` / `onOpenChange`）。 */
function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/** 切换按钮；展开时带 data-panel-open，可用 `group-data-[panel-open]:` 旋转箭头。 */
function CollapsibleTrigger(props: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

/** 内容区：收起时卸载（Base UI 默认），大块内容只在展开后才渲染；`keepMounted` 保留 DOM。 */
function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn("[&[hidden]:not([hidden='until-found'])]:hidden", className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
