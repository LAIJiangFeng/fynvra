import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type CompactionResult, estimateTokens } from '@earendil-works/pi-coding-agent';
import { type CompactionContext, thresholdTokens } from './types';

/**
 * Shake (after oh-my-pi `shake.ts` / `pruning.ts`): no LLM call. Large older tool results are
 * replaced in place with short placeholders through pi's public, append-only context edits;
 * user and assistant text is never touched and a recent tail stays intact. Superseded reads of
 * the same file go first. The edits are committed only when they bring the context below the
 * target; pi then records a compaction that keeps the whole (edited) history and refreshes
 * the live context.
 */

export const SHAKE_MARKER = '[Elided by context compaction';
/** Results smaller than this are not worth a placeholder. */
const MIN_RESULT_TOKENS = 200;
const ARGS_CHARS = 160;
/** Like oh-my-pi's recovery band: end well below the threshold so it does not refire at once. */
const RECOVERY_BAND = 0.8;
const NOTE =
  'No earlier history was summarized. Large older tool outputs were elided in place to free context; re-run the tool or re-read the file to recover them.';

interface Candidate {
  entryId: string;
  index: number;
  label: string;
  chars: number;
  tokens: number;
  images: ImageContent[];
  superseded: boolean;
}

export async function shake(ctx: CompactionContext): Promise<CompactionResult | 'skip'> {
  const { preparation, sessionManager } = ctx;
  const window = ctx.model.model.contextWindow;
  // Default protects 16k recent tokens (oh-my-pi); the aggressive pass only 4k.
  const protect = Math.floor(
    ctx.aggressive ? Math.min(4_000, window * 0.05) : Math.min(16_000, window * 0.2)
  );
  // The aggressive pass accepts anything under the threshold; the first aims at the band.
  const target = Math.floor(thresholdTokens(ctx) * (ctx.aggressive ? 1 : RECOVERY_BAND));
  const entries = sessionManager.buildSessionProjection().entries;
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const entry of entries) {
    for (const message of entry.messages) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) {
        if (block.type === 'toolCall')
          calls.set(block.id, { name: block.name, args: block.arguments });
      }
    }
  }
  const candidates: Candidate[] = [];
  const laterReads = new Set<string>();
  let recent = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    const message = entry.messages[0];
    if (
      entry.sourceEntry.type === 'message' &&
      entry.messages.length === 1 &&
      message?.role === 'toolResult'
    ) {
      const call = calls.get(message.toolCallId);
      const path = message.toolName === 'read' ? call?.args.path : undefined;
      const superseded = typeof path === 'string' && laterReads.has(path);
      if (typeof path === 'string') laterReads.add(path);
      const text = message.content
        .filter((block): block is TextContent => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const tokens = Math.ceil(text.length / 4);
      if (recent >= protect && tokens >= MIN_RESULT_TOKENS && !text.startsWith(SHAKE_MARKER)) {
        candidates.push({
          entryId: entry.sourceEntry.id,
          index,
          label: `${message.toolName}(${clip(JSON.stringify(call?.args ?? {}), ARGS_CHARS)})`,
          chars: text.length,
          tokens,
          images: message.content.filter((block): block is ImageContent => block.type === 'image'),
          superseded,
        });
      }
    }
    recent += entry.messages.reduce((sum, item) => sum + estimateTokens(item), 0);
  }
  // Superseded reads first, then oldest first.
  candidates.sort((a, b) => Number(b.superseded) - Number(a.superseded) || a.index - b.index);
  const chosen: { candidate: Candidate; placeholder: string }[] = [];
  let tokens = preparation.tokensBefore;
  for (const candidate of candidates) {
    if (tokens <= target) break;
    const placeholder = `${SHAKE_MARKER}: ${candidate.label} output, ${candidate.chars} characters (~${candidate.tokens} tokens). Re-run the tool or re-read the file to recover it.]`;
    chosen.push({ candidate, placeholder });
    tokens -= candidate.tokens - Math.ceil(placeholder.length / 4);
  }
  if (!chosen.length || tokens > target) return 'skip';
  const firstKept = entries.find((entry) => entry.sourceEntry.type !== 'compaction');
  if (!firstKept) return 'skip';
  ctx.signal.throwIfAborted();
  for (const { candidate, placeholder } of chosen) {
    sessionManager.appendContextEdit(candidate.entryId, {
      content: [{ type: 'text', text: placeholder }, ...candidate.images],
    });
  }
  ctx.log?.(`compaction shake: elided ${chosen.length} tool results`);
  const summary = preparation.previousSummary ?? NOTE;
  return {
    summary,
    // Keep everything: the reduction is in the edits, not in a cut.
    firstKeptEntryId: firstKept.sourceEntry.id,
    tokensBefore: preparation.tokensBefore,
    estimatedTokensAfter: tokens + (preparation.previousSummary ? 0 : Math.ceil(NOTE.length / 4)),
    details: { method: 'shake', elided: chosen.length },
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
