import type {
  CompactionResult,
  SessionBeforeCompactEvent,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';

export type Preparation = SessionBeforeCompactEvent['preparation'];

/** What every compaction method receives (one `session_before_compact` call). */
export interface CompactionContext {
  preparation: Preparation;
  model: ResolvedModel;
  /** Full manager: in-place methods append public context edits to it. */
  sessionManager: SessionManager;
  signal: AbortSignal;
  /** Second pass after every method failed: methods use more aggressive thresholds. */
  aggressive: boolean;
  /** Base backoff for transient provider errors (doubles per retry). */
  retryDelayMs?: number;
  log?(message: string): void;
}

/** A method throws, skips (not applicable / not enough), or returns a pi compaction result. */
export type CompactionMethodFn = (ctx: CompactionContext) => Promise<CompactionResult | 'skip'>;

/** pi compacts when tokens > window − reserve; methods aim below this. */
export function thresholdTokens(ctx: CompactionContext): number {
  return Math.max(0, ctx.model.model.contextWindow - ctx.preparation.settings.reserveTokens);
}
