import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { thinkingExpanded } from '@/stores/sessions/timeline';
import { useGeneralPreferencesStore } from '@/stores/settings';

/** 模型的思考过程：「思考时展开」打开时流式思考中展开、结束后收起，否则折叠；手动点过以手动为准。 */
export function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const autoExpand = useGeneralPreferencesStore((state) => state.timeline.autoExpandThinking);
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  return (
    <Collapsible
      open={thinkingExpanded(userToggled, active, autoExpand)}
      onOpenChange={(open) => setUserToggled(open)}
    >
      <CollapsibleTrigger className="group/thinking flex items-center gap-1.5 rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <Brain className={active ? 'size-3.5 animate-pulse' : 'size-3.5'} />
        {active ? '思考中…' : '思考过程'}
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/thinking:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3 text-muted-foreground text-xs leading-relaxed">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}
