import type {
  CompactionResult,
  InlineExtension,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { errorMessage } from '@shared/guards';
import { isContextOverflowError } from '../magicContext';
import { handoff } from './handoff';
import { remote } from './remote';
import { shake } from './shake';
import { soft } from './soft';
import type { CompactionContext, CompactionMethodFn } from './types';

/**
 * Ordered compaction methods, like oh-my-pi's `runAutoCompaction`: a method that throws, skips
 * or does not reduce the context hands over to the next one. When all fail, one more pass runs
 * with aggressive thresholds. Magic (when configured) sits in front of this chain.
 */
export const DEFAULT_COMPACTION_METHOD_ORDER = [
  'remote',
  'snapcompact',
  'handoff',
  'shake',
  'soft',
] as const;
export type CompactionMethod = (typeof DEFAULT_COMPACTION_METHOD_ORDER)[number];

// To add a method: write compaction/<name>.ts exporting a CompactionMethodFn and register it here.
export const COMPACTION_METHODS: Partial<Record<CompactionMethod, CompactionMethodFn>> = {
  remote,
  handoff,
  shake,
  soft,
};

export class CompactionChainError extends Error {}

/** Run the chain; throws CompactionChainError when every method failed, or the abort reason. */
export async function runCompactionChain(
  ctx: Omit<CompactionContext, 'aggressive'>,
  methods: Partial<Record<CompactionMethod, CompactionMethodFn>> = COMPACTION_METHODS
): Promise<CompactionResult> {
  for (const aggressive of [false, true]) {
    for (const name of DEFAULT_COMPACTION_METHOD_ORDER) {
      const method = methods[name];
      if (!method) continue;
      let outcome: string;
      try {
        const result = await method({ ...ctx, aggressive });
        if (
          result !== 'skip' &&
          (result.estimatedTokensAfter === undefined ||
            result.estimatedTokensAfter < ctx.preparation.tokensBefore)
        ) {
          return result;
        }
        outcome = result === 'skip' ? 'skipped' : 'no reduction';
      } catch (error) {
        ctx.signal.throwIfAborted();
        // Error kinds only: provider messages may echo prompt content.
        outcome = isContextOverflowError(errorMessage(error)) ? 'failed (overflow)' : 'failed';
      }
      ctx.log?.(`compaction method=${name}${aggressive ? ' aggressive' : ''} ${outcome}`);
    }
  }
  throw new CompactionChainError('every compaction method failed');
}

/**
 * `session_before_compact` hook answering with the chain while `active()`. When every method
 * fails it cancels (pi must not fall back to its default summary); the host reports that as a
 * non-blocking error, and the next message triggers compaction again.
 */
export function createCompactionChainExtension(options: {
  getModel(): ResolvedModel;
  getSessionManager(): SessionManager;
  active(): boolean;
  log?(message: string): void;
}): InlineExtension {
  return {
    name: 'fynvra-compaction-chain',
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_compact', async (event) => {
        if (!options.active()) return;
        try {
          return {
            compaction: await runCompactionChain({
              preparation: event.preparation,
              model: options.getModel(),
              sessionManager: options.getSessionManager(),
              signal: event.signal,
              ...(options.log ? { log: options.log } : {}),
            }),
          };
        } catch {
          // Never let pi fall back to its default summary.
          return { cancel: true };
        }
      });
    },
  };
}
