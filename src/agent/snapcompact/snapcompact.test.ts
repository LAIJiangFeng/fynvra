import { crc32, inflateSync } from 'node:zlib';
import type { CompactionResult } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { describe, expect, it } from 'vitest';
import type { CompactionContext } from '../compaction/types';
import { geometry, normalize, PNG_SIGNATURE, renderFrame, resolveShape } from './render';
import {
  attachArchive,
  createSnapcompactExtension,
  planFrames,
  readArchive,
  snapcompact,
} from './snapcompact';

const openai = resolveShape({ api: 'openai-responses', id: 'gpt-5' });

function model(input: string[], contextWindow = 400_000): ResolvedModel {
  return {
    runtime: {},
    model: { id: 'gpt-5', provider: 'p', api: 'openai-responses', input, contextWindow },
  } as unknown as ResolvedModel;
}

function context(
  resolved: ResolvedModel,
  texts: string[],
  branch: unknown[] = []
): CompactionContext {
  return {
    preparation: {
      firstKeptEntryId: 'kept-1',
      messagesToSummarize: texts.map((text, i) => ({
        role: 'user' as const,
        content: text,
        timestamp: i,
      })),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 300_000,
      fileOps: { read: new Set(['a.ts']), written: new Set(['b.ts']), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 },
    } as never,
    model: resolved,
    sessionManager: { getBranch: () => branch } as never,
    signal: new AbortController().signal,
    aggressive: false,
  };
}

const prose = (chars: number) =>
  'The quick brown fox jumps over the lazy dog; src/app.ts:42 failed.\n'.repeat(
    Math.ceil(chars / 66)
  );

describe('snapcompact renderer', () => {
  it('encodes a valid 1-bit PNG whose height hugs the printed rows (64px floor)', () => {
    const frame = renderFrame('Hello', openai);
    const png = Buffer.from(frame.data, 'base64');
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1568);
    expect(png.readUInt32BE(20)).toBe(64);
    expect([...png.subarray(24, 29)]).toEqual([1, 0, 0, 0, 0]);
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)));
    expect([frame.width, frame.height, frame.chars]).toEqual([1568, 64, 5]);

    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe((1568 / 8 + 1) * 64);
    // 'H' has ink in its first column (row 2), the paper right of the text stays white.
    expect(raw[2 * 197 + 1]).not.toBe(0xff);
    expect(raw[2 * 197 + 100]).toBe(0xff);

    const { cols } = geometry(openai);
    expect(renderFrame('x'.repeat(cols * 4), openai).height).toBe(4 * 22);
  });

  it('picks the per-provider shapes', () => {
    expect(resolveShape({ api: 'anthropic-messages', id: 'claude-sonnet-4' }).name).toBe(
      '11on16-bw'
    );
    expect(resolveShape({ api: 'google-generative-ai', id: 'gemini-3-pro' }).frameSize).toBe(2048);
    expect(openai).toMatchObject({ name: '8on22-bw', frameSize: 1568 });
  });

  it('counts glyphs the font lacks instead of dropping them silently', () => {
    const cjk = normalize('请修复登录页面的错误并运行测试 ok');
    expect(cjk.text).toContain('?');
    expect(cjk.fallbacks).toBeGreaterThan(10);
    expect(normalize('a — “b” → c ✅\n\n d').text).toBe('a - "b" -> c [OK]\u2588d');
  });
});

describe('snapcompact planner', () => {
  it('splits long text into frames within budget, pinning the head page', () => {
    const { capacity } = geometry(openai);
    const text = `${'h'.repeat(capacity)}${'m'.repeat(capacity * 5)}${'t'.repeat(capacity - 7)}`;
    expect(planFrames(text, capacity, 10).pages).toHaveLength(7);
    const { pages, truncatedChars } = planFrames(text, capacity, 3);
    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.length <= capacity)).toBe(true);
    expect(pages[0]?.startsWith('h')).toBe(true);
    expect(pages[2]?.endsWith('t')).toBe(true);
    expect(truncatedChars).toBe(capacity * 4);
  });
});

describe('snapcompact method', () => {
  it('skips a text-only model and mostly-CJK history', async () => {
    expect(await snapcompact(context(model(['text']), [prose(1_000)]))).toBe('skip');
    const cjk = '请修复登录页面的错误，然后运行全部测试并提交。'.repeat(50);
    expect(await snapcompact(context(model(['text', 'image']), [cjk]))).toBe('skip');
  });

  it('archives history as frames within the count, byte and token budgets', async () => {
    const result = (await snapcompact(
      context(model(['text', 'image']), [prose(400_000)])
    )) as CompactionResult;
    const archive = readArchive(result.details);
    expect(archive?.frames.length).toBeGreaterThan(1);
    expect(archive?.frames.length).toBeLessThanOrEqual(20);
    expect(archive?.frames.reduce((sum, f) => sum + f.data.length, 0)).toBeLessThanOrEqual(
      3_000_000
    );
    expect(archive?.truncatedChars).toBeGreaterThan(0);
    expect(result.summary).toContain(`${archive?.frames.length} images`);
    expect(result.summary).toContain('<modified-files>\nb.ts');
    expect(result.estimatedTokensAfter).toBeLessThan(300_000);
  });

  it('re-renders the previous archive ahead of the new history', async () => {
    const first = (await snapcompact(
      context(model(['text', 'image']), ['first turn'])
    )) as CompactionResult;
    const entry = { type: 'compaction', summary: first.summary, details: first.details };
    const ctx = context(model(['text', 'image']), ['second turn'], [entry]);
    ctx.preparation.previousSummary = first.summary;
    const second = (await snapcompact(ctx)) as CompactionResult;
    expect(readArchive(second.details)?.text).toBe('[User]: first turn\u2588[User]: second turn');
  });
});

describe('snapcompact context re-attachment', () => {
  it('re-attaches frames after the compaction summary on every context rebuild', async () => {
    const result = (await snapcompact(
      context(model(['text', 'image']), [prose(50_000)])
    )) as CompactionResult;
    const entry = { type: 'compaction', summary: result.summary, details: result.details };
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    createSnapcompactExtension().factory({
      on: (name: string, fn: typeof handler) => {
        if (name === 'context') handler = fn;
      },
    } as never);
    const messages = [
      { role: 'compactionSummary', summary: result.summary, tokensBefore: 1, timestamp: 5 },
      { role: 'user', content: 'next', timestamp: 6 },
    ];
    const run = (input: string[]) =>
      handler?.(
        { type: 'context', messages },
        {
          sessionManager: { getBranch: () => [entry] },
          model: { id: 'gpt-5', api: 'openai-responses', input },
        }
      ) as { messages: { role: string; content: { type: string; text?: string }[] }[] };

    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const out = run(['text', 'image']);
      expect(out.messages.map((m) => m.role)).toEqual(['compactionSummary', 'custom', 'user']);
      const images = out.messages[1]?.content.filter((block) => block.type === 'image');
      expect(images).toHaveLength(readArchive(result.details)?.frames.length ?? -1);
    }
    const textOnly = run(['text']).messages[1]?.content;
    expect(textOnly?.[0]?.text).toContain('The quick brown fox');
    expect(
      attachArchive(messages as never, { summary: 'other', details: result.details }, undefined)
    ).toBe(messages);
  });
});
