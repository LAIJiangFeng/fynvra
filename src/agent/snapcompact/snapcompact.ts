/**
 * Snapcompact compaction: archive older history as dense text-bitmap PNG frames that the current
 * vision model reads back. No LLM call. The summarized messages are serialized (pi's own
 * serializer), appended to the previous archive's kept text, and re-rendered into frames; the
 * frames and kept text persist in the compaction entry's `details.snapcompact` (session jsonl)
 * and a `context` hook re-attaches them right after the compaction summary on every request.
 *
 * Ported from oh-my-pi (packages/snapcompact/src/snapcompact.ts), MIT License,
 * Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük,
 * Copyright (c) 2026 Stencil Labs, Inc. Simplified: one shape per reader, no foveated tiers,
 * no dim ink, no text edges; the session head frame is pinned and the oldest middle dropped.
 *
 * Skips (falls through to the next method) when the model takes no image input, when no frame
 * fits the budget, or when more than 5% of the text has no glyph in the Latin-1 font: CJK-heavy
 * sessions would otherwise print as `?`, so they go to the text summary methods instead.
 */

import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  type CompactionEntry,
  type CompactionResult,
  type ContextEvent,
  convertToLlm,
  type ExtensionFactory,
  estimateTokens,
  getLatestCompactionEntry,
  type InlineExtension,
  serializeConversation,
} from '@earendil-works/pi-coding-agent';
import { type CompactionContext, thresholdTokens } from '../compaction/types';
import {
  frameTokens,
  geometry,
  isRenderable,
  NEWLINE_GLYPH,
  normalize,
  type RenderedFrame,
  renderFrame,
  resolveShape,
  type Shape,
} from './render';

/** Most frames per request: generous for the known wires, oh-my-pi's safe floor otherwise. */
const MAX_FRAMES = { anthropic: 20, openai: 20, google: 20, unknown: 5 } as const;
/** Base64 bytes the archive may add to every request (oh-my-pi's default payload budget). */
export const FRAME_BYTES_BUDGET = 3_000_000;
/** Share of the compaction threshold the frames may take (aggressive pass: half of it). */
const FRAME_TOKEN_SHARE = 0.5;
/** Newest archive characters handed to a reader without image input, as plain text. */
// shortcut: fixed cap, not sized to the reader's window; derive it from contextWindow if it matters.
const TEXT_FALLBACK_CHARS = 40_000;
const CUSTOM_TYPE = 'fynvra-snapcompact';

type Frame = RenderedFrame;

export interface SnapcompactArchive {
  version: 1;
  shape: Shape['name'];
  cols: number;
  rows: number;
  /** Oldest first. */
  frames: Frame[];
  /** Normalized source of the kept frames (oldest → newest), re-rendered by the next compaction. */
  text: string;
  /** Characters dropped so far to stay within the frame budget. */
  truncatedChars: number;
}

/** Split normalized text into frame pages; over `maxFrames`, keep the head page and the newest. */
export function planFrames(
  text: string,
  capacity: number,
  maxFrames: number
): { pages: string[]; truncatedChars: number } {
  const chars = [...text];
  const pages: string[] = [];
  for (let i = 0; i < chars.length; i += capacity) {
    pages.push(chars.slice(i, i + capacity).join(''));
  }
  if (pages.length <= maxFrames) return { pages, truncatedChars: 0 };
  const head = maxFrames > 1 ? pages.slice(0, 1) : [];
  const kept = [...head, ...pages.slice(pages.length - (maxFrames - head.length))];
  const dropped = pages.slice(head.length, pages.length - (maxFrames - head.length));
  return { pages: kept, truncatedChars: dropped.reduce((sum, page) => sum + [...page].length, 0) };
}

export async function snapcompact(ctx: CompactionContext): Promise<CompactionResult | 'skip'> {
  const { preparation } = ctx;
  const { model } = ctx.model;
  if (!model.input.includes('image')) return 'skip';
  const summarized = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const previousEntry = getLatestCompactionEntry(ctx.sessionManager.getBranch());
  const previous =
    previousEntry && previousEntry.summary === preparation.previousSummary
      ? readArchive(previousEntry.details)
      : undefined;
  const fresh = normalize(serializeConversation(convertToLlm(summarized)));
  const lead =
    !previous && preparation.previousSummary
      ? normalize(
          `[Summary of earlier history] ${preparation.previousSummary} [Recent conversation]`
        )
      : undefined;
  if (!fresh.text) return 'skip';
  // CJK (or any script the font lacks) would print as `?`: leave it to the text summary methods.
  if (!isRenderable(fresh) || (lead && !isRenderable(lead))) return 'skip';
  const text = [previous?.text, lead?.text, fresh.text].filter(Boolean).join(NEWLINE_GLYPH);

  const shape = resolveShape(model);
  const { cols, rows, capacity } = geometry(shape);
  const fullFrameTokens = frameTokens(shape, shape.frameSize, shape.frameSize);
  const tokenBudget = thresholdTokens(ctx) * FRAME_TOKEN_SHARE * (ctx.aggressive ? 0.5 : 1);
  const maxFrames = Math.min(MAX_FRAMES[shape.family], Math.floor(tokenBudget / fullFrameTokens));
  if (maxFrames < 1) return 'skip';
  const plan = planFrames(text, capacity, maxFrames);
  const pages = plan.pages;
  let truncatedChars = (previous?.truncatedChars ?? 0) + plan.truncatedChars;
  const frames = pages.map((page) => renderFrame(page, shape));
  // Byte budget: drop the oldest non-head frames until the payload fits.
  while (frames.reduce((sum, frame) => sum + frame.data.length, 0) > FRAME_BYTES_BUDGET) {
    if (frames.length <= 1) return 'skip';
    const drop = frames.length > 2 ? 1 : 0;
    truncatedChars += (frames.splice(drop, 1)[0] as Frame).chars;
    pages.splice(drop, 1);
  }
  ctx.signal.throwIfAborted();

  const { read, written, edited } = preparation.fileOps;
  const modified = new Set([...written, ...edited]);
  const readFiles = [...read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  const summary = summaryText({
    frames: frames.length,
    cols,
    rows,
    truncatedChars,
    digest: !!lead,
    readFiles,
    modifiedFiles,
  });
  const archive: SnapcompactArchive = {
    version: 1,
    shape: shape.name,
    cols,
    rows,
    frames,
    text: pages.join(''),
    truncatedChars,
  };
  const archiveTokens = (frames: Frame[]) =>
    frames.reduce((sum, frame) => sum + frameTokens(shape, frame.width, frame.height), 0);
  const removed =
    summarized.reduce((sum, message) => sum + estimateTokens(message), 0) +
    Math.ceil((preparation.previousSummary?.length ?? 0) / 4) +
    archiveTokens(previous?.frames ?? []);
  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    estimatedTokensAfter:
      Math.max(0, preparation.tokensBefore - removed) +
      Math.ceil(summary.length / 4) +
      archiveTokens(frames),
    details: { readFiles, modifiedFiles, snapcompact: archive },
  };
}

function summaryText(o: {
  frames: number;
  cols: number;
  rows: number;
  truncatedChars: number;
  digest: boolean;
  readFiles: string[];
  modifiedFiles: string[];
}): string {
  const block = (tag: string, files: string[]) =>
    files.length ? `\n\n<${tag}>\n${files.slice(0, 100).join('\n')}\n</${tag}>` : '';
  return [
    `Resume the prior conversation. Its earlier turns are archived as ${o.frames} image${o.frames === 1 ? '' : 's'} attached right after this summary, oldest first. Read them fully, then continue the live conversation that follows.`,
    '',
    'Archived transcript: turns open with `[User]:`, `[Assistant]:`, `[Assistant tool calls]: name(args)` or `[Tool result]:`.',
    'Reading the images:',
    `- Each image is one page of the transcript, a grid ${o.cols} characters wide and up to ${o.rows} rows tall; read left to right, top to bottom. No word wrap: words may break across rows.`,
    '- A solid black cell is a newline; runs of spaces collapse to one.',
    '- `?` marks a character the archive font cannot draw (for example CJK).',
    ...(o.digest ? ['- The archive opens with a condensed digest of still-older context.'] : []),
    ...(o.truncatedChars
      ? [
          `- About ${o.truncatedChars} characters of older middle history were dropped to fit the archive budget.`,
        ]
      : []),
    '- If an exact earlier detail matters and a page is unclear, re-derive it from the workspace (re-read files, re-run commands) rather than guess.',
  ]
    .join('\n')
    .concat(block('read-files', o.readFiles), block('modified-files', o.modifiedFiles));
}

/** Validate a persisted archive from compaction `details` (untrusted jsonl content). */
export function readArchive(details: unknown): SnapcompactArchive | undefined {
  const archive = (details as { snapcompact?: Partial<SnapcompactArchive> } | undefined)
    ?.snapcompact;
  if (
    archive?.version !== 1 ||
    typeof archive.text !== 'string' ||
    !Array.isArray(archive.frames)
  ) {
    return undefined;
  }
  const frames = archive.frames.filter(
    (frame): frame is Frame =>
      !!frame &&
      typeof frame.data === 'string' &&
      frame.data.length > 0 &&
      typeof frame.width === 'number' &&
      typeof frame.height === 'number' &&
      typeof frame.chars === 'number'
  );
  return {
    version: 1,
    shape: archive.shape === '11on16-bw' ? '11on16-bw' : '8on22-bw',
    cols: typeof archive.cols === 'number' ? archive.cols : 0,
    rows: typeof archive.rows === 'number' ? archive.rows : 0,
    frames,
    text: archive.text,
    truncatedChars: typeof archive.truncatedChars === 'number' ? archive.truncatedChars : 0,
  };
}

type ContextMessage = ContextEvent['messages'][number];
type Reader = { input?: readonly string[]; api?: string; id?: string } | undefined;

/**
 * Insert the archive of `entry` right after its compaction summary message. A reader with image
 * input gets the newest frames that fit its count and byte budget; any other reader gets the
 * newest archived text instead, so a model switch never silently loses the history.
 */
export function attachArchive(
  messages: ContextMessage[],
  entry: Pick<CompactionEntry, 'summary' | 'details'> | null | undefined,
  reader: Reader
): ContextMessage[] {
  const archive = entry ? readArchive(entry.details) : undefined;
  if (!entry || !archive) return messages;
  const at = messages.findIndex(
    (message) => message.role === 'compactionSummary' && message.summary === entry.summary
  );
  if (at < 0) return messages;
  const summaryMessage = messages[at] as ContextMessage;
  const archived: ContextMessage = {
    role: 'custom',
    customType: CUSTOM_TYPE,
    content: reader?.input?.includes('image')
      ? frameBlocks(archive, MAX_FRAMES[resolveShape(reader).family])
      : textFallback(archive),
    display: false,
    timestamp: summaryMessage.timestamp,
  };
  return [...messages.slice(0, at + 1), archived, ...messages.slice(at + 1)];
}

function frameBlocks(
  archive: SnapcompactArchive,
  maxFrames: number
): (TextContent | ImageContent)[] {
  const kept: ImageContent[] = [];
  let bytes = 0;
  for (const frame of [...archive.frames].reverse()) {
    if (kept.length >= maxFrames || bytes + frame.data.length > FRAME_BYTES_BUDGET) break;
    bytes += frame.data.length;
    kept.unshift({ type: 'image', data: frame.data, mimeType: 'image/png' });
  }
  const omitted = archive.frames.length - kept.length;
  return [
    {
      type: 'text',
      text: `Snapcompact archive, ${kept.length} frame${kept.length === 1 ? '' : 's'} oldest first${omitted ? ` (${omitted} older frame${omitted === 1 ? '' : 's'} omitted to fit this model's image budget)` : ''}:`,
    },
    ...kept,
  ];
}

function textFallback(archive: SnapcompactArchive): TextContent[] {
  const chars = [...archive.text];
  const omitted = Math.max(0, chars.length - TEXT_FALLBACK_CHARS);
  const text = chars.slice(omitted).join('').replaceAll(NEWLINE_GLYPH, '\n');
  return [
    {
      type: 'text',
      text: `The current model cannot read the snapcompact archive images; the newest archived transcript follows as text${omitted ? ` (${omitted} older characters omitted)` : ''}:\n\n${text}`,
    },
  ];
}

/** `context` hook: re-attach the latest compaction's archive on every context rebuild. */
export function createSnapcompactExtension(): Exclude<InlineExtension, ExtensionFactory> {
  return {
    name: 'fynvra-snapcompact',
    hidden: true,
    factory: (pi) => {
      pi.on('context', (event, ctx) => {
        if (!event.messages.some((message) => message.role === 'compactionSummary')) return;
        const entry = getLatestCompactionEntry(ctx.sessionManager.getBranch());
        const messages = attachArchive(event.messages, entry, ctx.model);
        return messages === event.messages ? undefined : { messages };
      });
    },
  };
}
