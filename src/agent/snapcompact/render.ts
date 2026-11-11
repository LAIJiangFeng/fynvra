/**
 * Snapcompact frame rendering: text → dense 1-bit PNG frames of pixel-font text that a vision
 * model reads back. Pure TypeScript port of the rasterizer oh-my-pi runs natively.
 *
 * Ported from oh-my-pi (packages/snapcompact/src/snapcompact.ts, crates/pi-natives/src/snapcompact.rs),
 * MIT License, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük,
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Only the two shapes oh-my-pi defaults to are kept, both 8x13 glyphs drawn at natural size, black
 * ink: `11on16-bw` (Anthropic, extra tracking) and `8on22-bw` (everything else, extra leading;
 * 2048px frames for Gemini, whose per-image bill is fixed). Frames are `frameSize` wide and their
 * height hugs the rows printed, with a 64px floor for vision processors that reject tiny images.
 * The font has no CJK glyphs and there is no fallback font: callers must check `normalize`'s
 * fallback ratio (see `isRenderable`) and not archive text that would print mostly as `?`.
 */
import { crc32, deflateSync } from 'node:zlib';
import { GLYPH_HEIGHT, glyphRows } from './font';

export type ApiFamily = 'anthropic' | 'google' | 'openai' | 'unknown';

export interface Shape {
  name: '8on22-bw' | '11on16-bw';
  cellWidth: number;
  cellHeight: number;
  frameSize: number;
  family: ApiFamily;
}

const MIN_FRAME_HEIGHT = 64;

function apiFamily(api: string | undefined): ApiFamily {
  switch (api) {
    case 'anthropic-messages':
    case 'bedrock-converse-stream':
      return 'anthropic';
    case 'openai-completions':
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
      return 'openai';
    case 'google-generative-ai':
    case 'google-gemini-cli':
    case 'google-vertex':
      return 'google';
    default:
      return 'unknown';
  }
}

/** Eval-winning shape for the reading model: its line (id) first, then its wire API family. */
export function resolveShape(model: { api?: string; id?: string }): Shape {
  const id = model.id ?? '';
  const family = /claude/i.test(id)
    ? 'anthropic'
    : /gemini/i.test(id)
      ? 'google'
      : apiFamily(model.api);
  // shortcut: oh-my-pi's 1932px high-res tier for Opus 4.7+/Fable is not ported; add it with a model-id check if needed.
  return family === 'anthropic'
    ? { name: '11on16-bw', cellWidth: 11, cellHeight: 16, frameSize: 1568, family }
    : {
        name: '8on22-bw',
        cellWidth: 8,
        cellHeight: 22,
        frameSize: family === 'google' ? 2048 : 1568,
        family,
      };
}

export function geometry(shape: Shape): { cols: number; rows: number; capacity: number } {
  const cols = Math.floor(shape.frameSize / shape.cellWidth);
  const rows = Math.floor(shape.frameSize / shape.cellHeight);
  return { cols, rows, capacity: cols * rows };
}

/**
 * Billed tokens for one frame, by oh-my-pi's per-wire fallback rules: OpenAI 32px patches × 1.2,
 * Gemini a fixed 1,120 per image, Anthropic (and unknown wires, the largest bill) 28px patches
 * capped at 4,784.
 */
export function frameTokens(shape: Shape, width: number, height: number): number {
  switch (shape.family) {
    case 'openai':
      return Math.ceil(Math.ceil(width / 32) * Math.ceil(height / 32) * 1.2);
    case 'google':
      return 1_120;
    default:
      return Math.min(4_784, Math.ceil(width / 28) * Math.ceil(height / 28));
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Printed in place of newline runs as a solid black cell, so line structure survives. */
export const NEWLINE_GLYPH = '\u2588';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;
/** Glyph-less code points dropped instead of printed: controls, combining marks, lone surrogates. */
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;
const COMBINING_MARKS = /\p{M}+/gu;
const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;

const CHAR_FOLD: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2032': "'",
  '\u2033': '"',
  '\u2039': '<',
  '\u203a': '>',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2044': '/',
  '\u2024': '.',
  '\u2025': '..',
  '\u2026': '...',
  '\u22ef': '...',
  '\u2022': '*',
  '\u2023': '*',
  '\u2043': '-',
  '\u2219': '*',
  '\u25cf': '*',
  '\u25a0': '*',
  '\u25aa': '*',
  '\u2190': '<-',
  '\u2191': '^',
  '\u2192': '->',
  '\u2193': 'v',
  '\u2194': '<->',
  '\u21d0': '<=',
  '\u21d2': '=>',
  '\u21d4': '<=>',
  '\u2713': 'v',
  '\u2714': 'v',
  '\u2717': 'x',
  '\u2718': 'x',
};

/** Status-like pictographs that carry meaning in tool output; other emoji are dropped. */
const EMOJI_FOLD: Record<string, string> = {
  '✅': '[OK]',
  '✔': '[OK]',
  '❌': '[FAIL]',
  '✖': '[FAIL]',
  '⚠': '[WARN]',
  '🚨': '[ALERT]',
  ℹ: '[INFO]',
  '🐛': '[BUG]',
};

const isLatin = (cp: number) => (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff);

/** NFKD fold of one code point to Latin-1 (fullwidth, ligatures, accents…), or undefined. */
function foldToLatin(ch: string): string | undefined {
  const decomposed = ch.normalize('NFKD').replace(COMBINING_MARKS, '');
  if (decomposed === ch) return undefined;
  let out = '';
  for (const part of decomposed) {
    const fold = isLatin(part.codePointAt(0) ?? 0) ? part : CHAR_FOLD[part];
    if (fold === undefined) return undefined;
    out += fold;
  }
  return out;
}

export interface Normalized {
  text: string;
  /** Printable characters counted (fold targets included). */
  graphics: number;
  /** Characters the font cannot draw, printed as `?` (e.g. CJK). */
  fallbacks: number;
}

/**
 * Prepare text for printing: strip ANSI, collapse whitespace (newline runs → one solid cell),
 * fold symbols to Latin-1, drop decorative emoji, print anything else undrawable as `?`.
 */
export function normalize(text: string): Normalized {
  const collapsed = text
    .replace(ANSI, '')
    .replace(COLLAPSIBLE, (run) =>
      LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? ' ' : ''
    )
    .replace(EDGE_RUNS, '');
  let out = '';
  let graphics = 0;
  let fallbacks = 0;
  for (const ch of collapsed) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isLatin(cp) || ch === NEWLINE_GLYPH) {
      out += ch;
      if (ch !== NEWLINE_GLYPH) graphics++;
      continue;
    }
    const folded =
      EMOJI_FOLD[ch] ??
      CHAR_FOLD[ch] ??
      (cp >= 0x2500 && cp <= 0x257f
        ? cp === 0x2502 || cp === 0x2503
          ? '|'
          : cp === 0x2500 || cp === 0x2501
            ? '-'
            : '+'
        : foldToLatin(ch));
    if (folded !== undefined) {
      out += folded;
      graphics++;
    } else if (!EMOJI_PICTOGRAPH.test(ch) && !UNRENDERABLE.test(ch)) {
      out += '?';
      graphics++;
      fallbacks++;
    }
  }
  return { text: out.replace(/ +/g, ' ').replace(EDGE_RUNS, ''), graphics, fallbacks };
}

/** Like oh-my-pi's `scanRenderability`: unsafe when more than 5% of characters would print as `?`. */
export const MAX_FALLBACK_RATIO = 0.05;

export function isRenderable(normalized: Normalized): boolean {
  return normalized.fallbacks <= normalized.graphics * MAX_FALLBACK_RATIO;
}

// ---------------------------------------------------------------------------
// Raster + PNG
// ---------------------------------------------------------------------------

export interface RenderedFrame {
  /** Base64 PNG. */
  data: string;
  width: number;
  height: number;
  /** Characters printed. */
  chars: number;
}

/** Render one page (at most `geometry(shape).capacity` code points) row-major, no word wrap. */
export function renderFrame(page: string, shape: Shape): RenderedFrame {
  const chars = [...page];
  const { cols, capacity } = geometry(shape);
  if (chars.length > capacity) throw new Error('page exceeds frame capacity');
  const width = shape.frameSize;
  const usedRows = Math.max(1, Math.ceil(chars.length / cols));
  const height = Math.max(MIN_FRAME_HEIGHT, usedRows * shape.cellHeight);
  const stride = Math.ceil(width / 8);
  // 1-bit grayscale, 1 = white paper; each row is prefixed with filter type 0.
  const raw = Buffer.alloc((stride + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (stride + 1)] = 0;
  const ink = (x: number, y: number) => {
    const at = y * (stride + 1) + 1 + (x >> 3);
    raw[at] = (raw[at] as number) & ~(0x80 >> (x & 7));
  };
  chars.forEach((ch, index) => {
    const left = (index % cols) * shape.cellWidth;
    const top = Math.floor(index / cols) * shape.cellHeight;
    const rows = ch === NEWLINE_GLYPH ? undefined : glyphRows(ch.codePointAt(0) ?? 0x3f);
    for (let r = 0; r < GLYPH_HEIGHT; r++) {
      const bits = rows ? (rows[r] as number) : 0xff;
      for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) ink(left + b, top + r);
    }
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([1, 0, 0, 0, 0], 8); // bit depth 1, grayscale, deflate, filter 0, no interlace
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { data: png.toString('base64'), width, height, chars: chars.length };
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
