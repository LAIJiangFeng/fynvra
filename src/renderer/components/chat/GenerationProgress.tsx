import type { SessionStatus } from '@shared/types/chat';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { isBusy, useSessionsStore } from '@/stores/sessions';
import { compactionActive } from '@/stores/sessions/reducer';
import { compactionFailure } from './contextDisplay';
import { ElapsedWait } from './ElapsedWait';

/** Isolated subscriptions and clock keep progress updates out of the virtualized message tree. */
export function GenerationProgress({
  sessionId,
  status,
  showWorking,
  error,
}: {
  sessionId: string;
  status: SessionStatus;
  showWorking: boolean;
  error: string | undefined;
}) {
  const compaction = useSessionsStore((state) => state.runtimeBySession[sessionId]?.compaction);
  const retry = useSessionsStore((state) => state.runtimeBySession[sessionId]?.retry);
  const recoveryRequired = useSessionsStore(
    (state) => state.runtimeBySession[sessionId]?.recoveryRequired
  );
  const magic = useSessionsStore(
    (state) =>
      state.runtimeBySession[sessionId]?.contextRuntime?.configuredStrategy === 'magic-context'
  );
  const recovering = useSessionsStore((state) => state.recoveringCompaction[sessionId] === true);
  const stopping = useSessionsStore((state) => state.stopping[sessionId] === true);
  const retryCompaction = useSessionsStore((state) => state.retryCompaction);
  const t = useT();
  const compacting = compactionActive(compaction);
  const failure = recoveryRequired ? compactionFailure(compaction, t) : undefined;
  const retrying = retry && retry.phase !== 'finished';
  const label =
    status === 'waiting-approval'
      ? t('sessions.status.waiting-approval')
      : retrying
        ? t(retry.kind === 'summarization' ? 'chat.summaryRetrying' : 'chat.modelRetrying', {
            attempt: retry.attempt,
            max: retry.maxAttempts,
          })
        : compacting
          ? t('chat.compacting')
          : recovering && compaction?.phase !== 'succeeded'
            ? t('chat.compactionRecovering')
            : status === 'running' && showWorking
              ? t('chat.working')
              : undefined;
  const problem =
    !compacting && !recovering
      ? (magic && recoveryRequired ? t('chat.magicContextFallback') : undefined) ||
        failure ||
        error ||
        (recoveryRequired && !isBusy(status) ? t('chat.compactionFailed') : undefined)
      : undefined;
  return (
    <div className="mx-auto max-w-3xl px-6 pb-6">
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
        {label && (
          <span role="status" aria-live="polite" className="flex items-center gap-2 py-2">
            {status !== 'waiting-approval' && (
              <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
            )}
            {label}
          </span>
        )}
        {compacting && compaction && <ElapsedWait startedAt={compaction.startedAt} />}
      </div>
      {problem && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{problem}</span>
          {recoveryRequired && (
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy(status) || stopping}
              onClick={() => void retryCompaction(sessionId)}
            >
              {t('chat.retryCompaction')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
