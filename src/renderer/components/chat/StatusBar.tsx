import { findSession, useSessionsStore } from '@/stores/sessions';
import { formatCost, formatTokens } from './format';

/** 会话底部一行：累计 tokens、费用（有才显示）、模型。 */
export function StatusBar({ sessionId }: { sessionId: string }) {
  const usage = useSessionsStore((state) => state.runtimeBySession[sessionId]?.usage);
  const reportedModel = useSessionsStore((state) => state.runtimeBySession[sessionId]?.model);
  const sessionModel = useSessionsStore((state) => findSession(state, sessionId)?.model?.modelId);
  const model = reportedModel ?? sessionModel;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t px-4 text-muted-foreground text-xs">
      <span title="累计输入 / 输出 tokens">
        tokens ↑{formatTokens(usage?.inputTokens ?? 0)} ↓{formatTokens(usage?.outputTokens ?? 0)}
      </span>
      {usage && usage.costUsd > 0 && <span title="累计费用">{formatCost(usage.costUsd)}</span>}
      {model && (
        <span className="ml-auto min-w-0 truncate font-mono" title="模型">
          {model}
        </span>
      )}
    </footer>
  );
}
