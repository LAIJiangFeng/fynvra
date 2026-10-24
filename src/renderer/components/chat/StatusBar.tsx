import { THINKING_LEVEL_HINTS } from '@shared/types/chat';
import { GitBranch } from 'lucide-react';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';
import { ApprovalModeStatus } from './ApprovalModePicker';
import { formatCost, formatTokens } from './format';
import { useSessionModel } from './ModelPicker';

/**
 * 会话底部一行：累计 tokens、费用（有才显示）；右侧是审批档位、当前分支（悬停看 cwd），
 * 以及模型（点了打开与输入框胶囊同一个模型选择器）。
 */
export function StatusBar({ sessionId }: { sessionId: string }) {
  const usage = useSessionsStore((state) => state.runtimeBySession[sessionId]?.usage);
  const reportedModel = useSessionsStore((state) => state.runtimeBySession[sessionId]?.model);
  const branch = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.branch);
  const cwd = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.cwd);
  const openModelPicker = useSessionsStore((state) => state.openModelPicker);
  // 当前选的模型（切换后立刻变）；会话没记模型时退回用量事件里报的
  const { label, thinking } = useSessionModel(sessionId);
  const model = label ? [label.model, label.thinking].filter(Boolean).join(' · ') : reportedModel;
  const hint = thinking ? `（${THINKING_LEVEL_HINTS[thinking]}）` : '';

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t px-4 text-muted-foreground text-xs">
      <span title="累计输入 / 输出 tokens" className="shrink-0">
        tokens ↑{formatTokens(usage?.inputTokens ?? 0)} ↓{formatTokens(usage?.outputTokens ?? 0)}
      </span>
      {usage && usage.costUsd > 0 && (
        <span title="累计费用" className="shrink-0">
          {formatCost(usage.costUsd)}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <ApprovalModeStatus sessionId={sessionId} />
        {branch && (
          <span
            title={cwd ? `当前分支（${cwd}）` : '当前分支'}
            className="flex min-w-0 items-center gap-1 font-mono"
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
        {model && (
          <button
            type="button"
            title={label ? `${label.provider} · ${model}${hint}，点击切换模型` : '切换模型'}
            className="min-w-0 truncate rounded-sm font-mono outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => openModelPicker(sessionId)}
          >
            {model}
          </button>
        )}
      </div>
    </footer>
  );
}
