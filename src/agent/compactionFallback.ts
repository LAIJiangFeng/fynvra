import type { Message } from '@earendil-works/pi-ai';
import {
  type CompactionResult,
  convertToLlm,
  type InlineExtension,
  type SessionBeforeCompactEvent,
  serializeConversation,
} from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { errorMessage } from '@shared/guards';
import {
  estimatePromptTokens,
  isContextOverflowError,
  isTransientModelError,
  withAbort,
} from './magicContext';

/**
 * Compaction fallback chain (after oh-my-pi): a robust model summary that folds oversized
 * history into windows, then a deterministic local summary that cannot fail. Used as the
 * `session_before_compact` result for native sessions and for Magic sessions after Magic stopped.
 */

type Preparation = SessionBeforeCompactEvent['preparation'];

/** Use only this share of the advertised window, like oh-my-pi. */
const WINDOW_SAFETY = 0.8;
const FRAMING_TOKENS = 1_024;
const MAX_SUMMARY_TOKENS = 16_384;
/** Below this input budget a model summary is not worth sending; the local summary takes over. */
const MIN_WINDOW_TOKENS = 1_024;
const TRANSIENT_RETRIES = 2;
const LOCAL_REQUEST_CHARS = 300;
const LOCAL_REQUESTS_TOTAL_CHARS = 6_000;
const LOCAL_PREVIOUS_SUMMARY_CHARS = 12_000;
const LOCAL_MAX_FILES = 100;

const SYSTEM_PROMPT =
  'You are a context summarization assistant. Read the conversation between a user and an AI assistant and write a structured checkpoint summary. Do NOT continue the conversation or answer its questions. Output ONLY the summary.';
const INSTRUCTION = [
  'Create a structured context checkpoint that another LLM will use to continue the work, in the language of the conversation.',
  'Sections: ## Goal, ## Constraints & Preferences, ## Progress (Done / In Progress / Blocked), ## Key Decisions, ## Next Steps, ## Critical Context (exact file paths, names, commands, errors).',
  'Be concise; keep every detail needed to continue.',
].join('\n');
const UPDATE_INSTRUCTION = `Update the summary in <previous-summary> with the NEW conversation above. Keep all still-relevant information, move finished items to Done, and add new progress, decisions and context.\n${INSTRUCTION}`;

export interface FallbackOptions {
  signal: AbortSignal;
  /** Deadline for the model part; on expiry the local summary is used. */
  deadlineMs?: number;
  /** Base backoff for transient provider errors (doubles per retry). */
  retryDelayMs?: number;
  log?(message: string): void;
}

/** Model summary, then local summary. Throws only when the caller's signal aborted. */
export async function fallbackCompaction(
  preparation: Preparation,
  resolved: ResolvedModel,
  options: FallbackOptions
): Promise<CompactionResult> {
  const signal = options.deadlineMs
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.deadlineMs)])
    : options.signal;
  try {
    return await robustSummary(preparation, resolved, { ...options, signal });
  } catch (error) {
    options.signal.throwIfAborted();
    // Error kinds only: provider messages may echo prompt content.
    const kind = signal.aborted
      ? 'timeout'
      : isContextOverflowError(errorMessage(error))
        ? 'overflow'
        : 'error';
    options.log?.(`compaction fallback: model summary failed (${kind}); using local summary`);
    return localSummary(preparation);
  }
}

/** Fold the history into budget-sized windows, each updating the carried summary. */
export async function robustSummary(
  preparation: Preparation,
  resolved: ResolvedModel,
  options: FallbackOptions
): Promise<CompactionResult> {
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
  const { readFiles, modifiedFiles } = fileLists(preparation);
  return {
    summary: (carried ?? '') + formatFiles(readFiles, modifiedFiles),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}

/** Deterministic summary from the preparation alone; used when no model summary is possible. */
export function localSummary(preparation: Preparation): CompactionResult {
  const requests: string[] = [];
  let total = 0;
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = userText(message as Message)
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const clipped =
      text.length > LOCAL_REQUEST_CHARS ? `${text.slice(0, LOCAL_REQUEST_CHARS)}…` : text;
    if (total + clipped.length > LOCAL_REQUESTS_TOTAL_CHARS) break;
    requests.push(`- ${clipped}`);
    total += clipped.length;
  }
  requests.reverse();
  const lines = [
    'Earlier conversation history was compacted locally without a model (summary generation failed). Details from that part of the conversation may be missing; re-read files when needed.',
  ];
  if (preparation.previousSummary) {
    lines.push(
      '',
      '## Previous summary',
      preparation.previousSummary.slice(0, LOCAL_PREVIOUS_SUMMARY_CHARS)
    );
  }
  if (requests.length) lines.push('', '## User requests (oldest first)', ...requests);
  const { readFiles, modifiedFiles } = fileLists(preparation);
  // shortcut: the kept tail is not elided; if it alone overflows the window, the next request
  // fails and recovery stays explicit. Elide kept tool outputs when that shows up in practice.
  return {
    summary: lines.join('\n') + formatFiles(readFiles, modifiedFiles),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}

/** `session_before_compact` hook that answers with the fallback chain while `active()`. */
export function createCompactionFallbackExtension(options: {
  getModel(): ResolvedModel;
  active(): boolean;
  /** Host compaction timeout; the model part gets a share of it so the local summary fits. */
  timeoutMs: number;
  log?(message: string): void;
}): InlineExtension {
  return {
    name: 'fynvra-compaction-fallback',
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_compact', async (event) => {
        if (!options.active()) return;
        return {
          compaction: await fallbackCompaction(event.preparation, options.getModel(), {
            signal: event.signal,
            deadlineMs: Math.max(1, Math.floor(options.timeoutMs * 0.75)),
            ...(options.log ? { log: options.log } : {}),
          }),
        };
      });
    },
  };
}

class OverflowError extends Error {}

async function summarizeWindow(
  resolved: ResolvedModel,
  conversation: string,
  previous: string | undefined,
  maxTokens: number,
  options: FallbackOptions
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
    if (attempt >= TRANSIENT_RETRIES || !transient) {
      throw new Error('summary request failed');
    }
    await sleep((options.retryDelayMs ?? 1_000) * 2 ** attempt, signal);
  }
}

function truncate(text: string, budgetTokens: number): string {
  // estimatePromptTokens counts 2 UTF-8 bytes per token; a UTF-16 unit is at most 3 bytes.
  const keep = Math.max(0, Math.floor((budgetTokens * 2) / 3) - 80);
  return `${text.slice(0, keep)}\n[… ${text.length - keep} characters truncated for compaction …]`;
}

function userText(message: Message): string {
  if (message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
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
    files.length ? `\n\n<${tag}>\n${files.slice(0, LOCAL_MAX_FILES).join('\n')}\n</${tag}>` : '';
  return block('read-files', readFiles) + block('modified-files', modifiedFiles);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return withAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}
