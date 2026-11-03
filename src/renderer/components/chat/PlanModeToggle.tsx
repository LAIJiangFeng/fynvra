import { NotebookPen } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';
import { isOrchestratorRole, useRoles } from './roles';

/**
 * 输入框工具栏里、审批胶囊旁的「计划模式」开关。只给主 agent 会话（内置 orchestrator，或工具策略为
 * orchestrator 的自定义角色），派发出的 worker 会话不显示。开启时主 agent 只把计划写成文档
 * （.fynvra/plans），不派发任务；审阅后关掉再按计划派发。运行中也能切，状态随会话保存。
 */
export function PlanModeToggle({ sessionId }: { sessionId: string }) {
  const roleId = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.roleId);
  const dispatched = useSessionsStore(
    (state) => selectSessionOf(sessionId)(state)?.dispatchId !== undefined
  );
  const enabled = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.planMode === true);
  const setPlanMode = useSessionsStore((state) => state.setPlanMode);
  const roles = useRoles();
  const t = useT();
  if (!roleId || dispatched || !isOrchestratorRole(roleId, roles)) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-muted-foreground text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
              enabled &&
                'border-violet-500/50 bg-violet-500/15 font-medium text-violet-700 hover:bg-violet-500/25 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200'
            )}
          />
        }
        aria-pressed={enabled}
        onClick={() => void setPlanMode(sessionId, !enabled)}
      >
        <NotebookPen aria-hidden className="size-3.5 shrink-0" />
        <span>{t('planMode.label')}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{t('planMode.hint')}</TooltipContent>
    </Tooltip>
  );
}
