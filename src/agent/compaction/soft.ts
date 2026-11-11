import {
  type CompactionResult,
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { errorMessage } from '@shared/guards';
import {
  estimatePromptTokens,
  isContextOverflowError,
  isTransientModelError,
  withAbort,
} from '../magicContext';
import type { CompactionContext, Preparation } from './types';

/**
 * Soft compaction (oh-my-pi "soft"): an LLM summary that cannot be broken by size. History
 * that does not fit is folded into windows (each updating the carried summary), a single
 * oversized message is truncated, a provider overflow halves the budget and re-plans, and
 * transient errors are retried with backoff. No reasoning is requested.
 */

/** Use only this share of the advertised window, like oh-my-pi. */
const WINDOW_SAFETY = 0.8;
const FRAMING_TOKENS = 1_024;
const MAX_SUMMARY_TOKENS = 16_384;
/** Below this input budget a summary is not worth sending; the method fails. */
const MIN_WINDOW_TOKENS = 1_024;
const TRANSIENT_RETRIES = 2;
const MAX_FILES = 100;

const SYSTEM_PROMPT =
  'You are a context summarization assistant. Read the conversation between a user and an AI assistant and write a structured checkpoint summary. Do NOT continue the conversation or answer its questions. Output ONLY the summary.';
const INSTRUCTION = [
  'Create a structured context checkpoint that another LLM will use to continue the work, in the language of the conversation.',
  'Sections: ## Goal, ## Constraints & Preferences, ## Progress (Done / In Progress / Blocked), ## Key Decisions, ## Next Steps, ## Critical Context (exact file paths, names, commands, errors).',
  'Be concise; keep every detail needed to continue.',
].join('\n');
const UPDATE_INSTRUCTION = `Update the summary in <previous-summary> with the NEW conversation above. Keep all still-relevant information, move finished items to Done, and add new progress, decisions and context.\n${INSTRUCTION}`;

export async function soft(ctx: CompactionContext): Promise<CompactionResult> {
  const { preparation } = ctx;
  const summarized = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const carried = await robustSummary(preparation, ctx.model, ctx);
  const { readFiles, modifiedFiles } = fileLists(preparation);
  const summary = carried + formatFiles(readFiles, modifiedFiles);
  // pi's chars/4 estimate, the same one tokensBefore uses.
  const removed =
    summarized.reduce((sum, message) => sum + estimateTokens(message), 0) +
    Math.ceil((preparation.previousSummary?.length ?? 0) / 4);
  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    estimatedTokensAfter:
      Math.max(0, preparation.tokensBefore - removed) + Math.ceil(summary.length / 4),
    details: { readFiles, modifiedFiles },
  };
}

/** Fold the history into budget-sized windows; returns the final carried summary text. */
export async function robustSummary(
  preparation: Preparation,
  resolved: ResolvedModel,
  options: Pick<CompactionContext, 'signal' | 'retryDelayMs'>
): Promise<string> {
  const { model } = resolved;
  const window = model.contextWindow;
  const maxTokens = Math.floor(
    Math.min(model.maxTokens || MAX_SUMMARY_TOKENS, MAX_SUMMARY_TOKENS, window * 0.2)
  );
  if (!Number.isFinite(window) || window <= 0 || maxTokens < 256) {
    throw new Error('model window too small for a summary');
  }
  const pieces = convertToLlm([
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ]).map((message) => serializeConversation([message]));
  let carried = preparation.previousSummary;
  let scale = 1;
  let index = 0;
  while (index < pieces.length) {
    const fixed = estimatePromptTokens(SYSTEM_PROMPT + UPDATE_INSTRUCTION + (carried ?? ''));
    const budget = Math.floor(
      (window * WINDOW_SAFETY - maxTokens - FRAMING_TOKENS - fixed) * scale
    );
    if (budget < MIN_WINDOW_TOKENS) throw new Error('summary budget exhausted');
    const chunk: string[] = [];
    let used = 0;
    let end = index;
    while (end < pieces.length) {
      const cost = estimatePromptTokens(`${pieces[end]}\n\n`);
      if (used + cost > budget) break;
      chunk.push(pieces[end] as string);
      used += cost;
      end++;
    }
    if (end === index) {
      // A single oversized message is truncated instead of failing the compaction.
      chunk.push(truncate(pieces[index] as string, budget));
      end = index + 1;
    }
    try {
      carried = await summarizeWindow(resolved, chunk.join('\n\n'), carried, maxTokens, options);
    } catch (error) {
      if (!(error instanceof OverflowError)) throw error;
      scale /= 2;
      continue;
    }
    index = end;
  }
  if (!carried) throw new Error('nothing to summarize');
  return carried;
}

class OverflowError extends Error {}

async function summarizeWindow(
  resolved: ResolvedModel,
  conversation: string,
  previous: string | undefined,
  maxTokens: number,
  options: Pick<CompactionContext, 'signal' | 'retryDelayMs'>
): Promise<string> {
  const { signal } = options;
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${
    previous
      ? `<previous-summary>\n${previous}\n</previous-summary>\n\n${UPDATE_INSTRUCTION}`
      : INSTRUCTION
  }`;
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    let transient: boolean;
    try {
      const answer = await withAbort(
        resolved.runtime.completeSimple(
          resolved.model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          },
          {
            maxTokens,
            maxRetries: 0,
            signal,
            // Omitted reasoning means "off"; models that cannot disable it get their lowest level.
            ...(resolved.model.reasoning && resolved.model.thinkingLevelMap?.off === null
              ? { reasoning: 'minimal' as const }
              : {}),
          }
        ),
        signal
      );
      signal.throwIfAborted();
      const text = answer.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
      if (answer.stopReason === 'stop' && text) return text;
      failure = answer.errorMessage ?? '';
      // Empty text or an abort the caller did not request are worth another attempt;
      // a partial (length-capped) summary is not.
      transient =
        answer.stopReason !== 'length' &&
        (answer.stopReason !== 'error' || isTransientModelError(failure));
    } catch (error) {
      signal.throwIfAborted();
      failure = errorMessage(error);
      transient = isTransientModelError(failure);
    }
    if (isContextOverflowError(failure)) throw new OverflowError('context overflow');
    // Fixed text: provider messages may echo prompt content.
    if (attempt >= TRANSIENT_RETRIES || !transient) throw new Error('summary request failed');
    await sleep((options.retryDelayMs ?? 1_000) * 2 ** attempt, signal);
  }
}

function truncate(text: string, budgetTokens: number): string {
  // estimatePromptTokens counts 2 UTF-8 bytes per token; a UTF-16 unit is at most 3 bytes.
  const keep = Math.max(0, Math.floor((budgetTokens * 2) / 3) - 80);
  return `${text.slice(0, keep)}\n[… ${text.length - keep} characters truncated for compaction …]`;
}

function fileLists(preparation: Preparation): { readFiles: string[]; modifiedFiles: string[] } {
  const { read, written, edited } = preparation.fileOps;
  const modified = new Set([...written, ...edited]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFiles(readFiles: string[], modifiedFiles: string[]): string {
  const block = (tag: string, files: string[]) =>
    files.length ? `\n\n<${tag}>\n${files.slice(0, MAX_FILES).join('\n')}\n</${tag}>` : '';
  return block('read-files', readFiles) + block('modified-files', modifiedFiles);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return withAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}
