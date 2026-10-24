import { Brain, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/** 模型的思考过程，默认折叠。 */
export function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  return (
    <Collapsible>
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
