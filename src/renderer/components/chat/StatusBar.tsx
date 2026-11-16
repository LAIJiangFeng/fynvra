import { FoldVertical, GitBranch, Loader2, Zap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { isBusy, statusOf, useSessionsStore } from '@/stores/sessions';
import { compactionActive } from '@/stores/sessions/reducer';
import { useGeneralPreferencesStore } from '@/stores/settings';
import { ApprovalModeStatus } from './ApprovalModePicker';
import { contextLabel, strategyLabel, strategyNotice } from './contextDisplay';
import { formatCost, formatTokens } from './format';
import { useSessionModel } from './ModelPicker';
import { useSessionBranch } from './SessionBadges';

/**
 * 会话底部一行：累计 tokens、费用（有才显示）；右侧是审批档位、当前分支（悬停看 cwd），
 * 以及模型（点了打开与输入框胶囊同一个模型选择器）。
 */
export function StatusBar({ sessionId }: { sessionId: string }) {
  const usage = useSessionsStore((state) => state.runtimeBySession[sessionId]?.usage);
  const snapshot = useSessionsStore((state) => state.runtimeBySession[sessionId]?.contextRuntime);
  const selected = useGeneralPreferencesStore((state) => state.compaction);
  const reportedModel = useSessionsStore((state) => state.runtimeBySession[sessionId]?.model);
  const branch = useSessionBranch(sessionId);
  const openModelPicker = useSessionsStore((state) => state.openModelPicker);
  const compactContext = useSessionsStore((state) => state.compactContext);
  const compactDisabled = useSessionsStore((state) => {
    const runtime = state.runtimeBySession[sessionId];
    return (
      isBusy(statusOf(state, sessionId)) ||
      compactionActive(runtime?.compaction) ||
      runtime?.recoveryRequired === true ||
      state.compactRequests[sessionId] === true ||
      state.recoveringCompaction[sessionId] === true ||
      state.stopping[sessionId] === true
    );
  });
  const compacting = useSessionsStore(
    (state) =>
      compactionActive(state.runtimeBySession[sessionId]?.compaction) ||
      state.compactRequests[sessionId] === true
  );
  const t = useT();
  // 当前选的模型（切换后立刻变）；会话没记模型时退回用量事件里报的
  const { label, fastMode } = useSessionModel(sessionId);
  const model = label ? [label.model, label.thinking].filter(Boolean).join(' · ') : reportedModel;

  const context = contextLabel(snapshot, t);
  const total = `${t('chat.usageTotal')} ↑${formatTokens(usage?.inputTokens ?? 0)} ↓${formatTokens(usage?.outputTokens ?? 0)} ${formatCost(usage?.costUsd ?? 0)}`;
  const engine = t('chat.actualEngine', { engine: strategyLabel(snapshot?.effectiveStrategy, t) });
  const details = [
    context.label,
    context.nearThreshold ? t('chat.contextNearThreshold') : '',
    context.hint,
    engine,
    t('chat.configuredEngine', { engine: strategyLabel(snapshot?.configuredStrategy, t) }),
    t('chat.selectedEngine', { engine: strategyLabel(selected, t) }),
    strategyNotice(snapshot, selected, t),
    t('chat.tokensHint'),
    total,
    t('chat.costHint'),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1 text-muted-foreground text-xs">
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          className="min-w-0 max-w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={details}
        >
          {context.label}
          {context.nearThreshold ? ` · ${t('chat.contextNearThreshold')}` : ''}
        </TooltipTrigger>
        <TooltipContent className="max-w-sm whitespace-pre-line">{details}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={t('chat.compactNow')}
        title={t('chat.compactNow')}
        disabled={compactDisabled}
        className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        onClick={() => void compactContext(sessionId)}
      >
        {compacting ? (
          <Loader2 aria-hidden className="size-3 animate-spin" />
        ) : (
          <FoldVertical aria-hidden className="size-3" />
        )}
        {compacting ? t('chat.compactingShort') : t('chat.compactShort')}
      </button>
      <span className="min-w-0 max-w-full truncate" title={details}>
        {engine}
      </span>
      <span
        title={`${t('chat.tokensHint')} · ${t('chat.costHint')}`}
        className="min-w-0 max-w-full truncate"
      >
        {total}
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <ApprovalModeStatus sessionId={sessionId} />
        {branch && (
          <span
            title={t('chat.branchHint', { cwd: branch.cwd })}
            className="flex min-w-0 items-center gap-1 font-mono"
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{branch.branch}</span>
          </span>
        )}
        {fastMode && (
          <span
            title={t('model.fastHint')}
            className="flex shrink-0 items-center gap-1 font-medium text-amber-700 dark:text-amber-300"
          >
            <Zap aria-hidden className="size-3 shrink-0" />
            {t('model.fast')}
          </span>
        )}
        {model && (
          <button
            type="button"
            title={
              label
                ? t('model.switchCurrent', { model: `${label.provider} · ${model}` })
                : t('model.switch')
            }
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
