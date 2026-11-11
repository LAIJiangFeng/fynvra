import type { ResolvedModel } from '@fynvra/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { fallbackCompaction, robustSummary } from './compactionFallback';

type Reply = { text?: string; error?: string };

function model(replies: Reply[]) {
  const prompts: string[] = [];
  const completeSimple = vi.fn(
    async (_model: unknown, context: { messages: { content: string }[] }) => {
      prompts.push(context.messages[0]?.content ?? '');
      const reply = replies.shift() ?? { text: 'summary' };
      return {
        role: 'assistant',
        content: reply.text ? [{ type: 'text', text: reply.text }] : [],
        stopReason: reply.error ? 'error' : 'stop',
        ...(reply.error ? { errorMessage: reply.error } : {}),
      };
    }
  );
  const resolved = {
    runtime: { completeSimple },
    model: {
      id: 'm',
      provider: 'p',
      api: 'openai-completions',
      contextWindow: 10_000,
      maxTokens: 1_000,
      reasoning: false,
    },
  } as unknown as ResolvedModel;
  return { resolved, prompts, completeSimple };
}

function preparation(texts: string[], previousSummary?: string) {
  return {
    firstKeptEntryId: 'kept-1',
    messagesToSummarize: texts.map((text, i) => ({
      role: 'user' as const,
      content: text,
      timestamp: i,
    })),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123_456,
    ...(previousSummary ? { previousSummary } : {}),
    fileOps: { read: new Set(['a.ts', 'b.ts']), written: new Set(['b.ts']), edited: new Set() },
    settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
  } as never;
}

const signal = new AbortController().signal;

describe('robust compaction summary', () => {
  it('folds an oversized history into windows that carry the summary forward', async () => {
    const { resolved, prompts } = model([{ text: 'S1' }, { text: 'S2' }, { text: 'S3' }]);
    const texts = Array.from({ length: 6 }, (_, i) => `request-${i} ${'x'.repeat(4_000)}`);
    const result = await robustSummary(preparation(texts), resolved, { signal });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).not.toContain('<previous-summary>');
    expect(prompts[1]).toContain('<previous-summary>\nS1\n');
    expect(prompts.join('')).toContain('request-5');
    expect(result).toMatchObject({ firstKeptEntryId: 'kept-1', tokensBefore: 123_456 });
    expect(result.summary).toContain(`S${prompts.length}`);
    expect(result.details).toEqual({ readFiles: ['a.ts'], modifiedFiles: ['b.ts'] });
  });

  it('truncates a single oversized message instead of failing', async () => {
    const { resolved, prompts } = model([{ text: 'short' }]);
    const result = await robustSummary(preparation(['y'.repeat(200_000)]), resolved, { signal });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('truncated for compaction');
    expect(Buffer.byteLength(prompts[0] ?? '')).toBeLessThan(16_000);
    expect(result.summary).toContain('short');
  });

  it('halves the window budget after a provider context overflow, then succeeds', async () => {
    const { resolved, prompts } = model([
      { error: 'context_length_exceeded: maximum context length' },
      { text: 'after overflow' },
    ]);
    const texts = Array.from({ length: 4 }, (_, i) => `m${i} ${'z'.repeat(2_000)}`);
    const result = await robustSummary(preparation(texts), resolved, { signal });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect((prompts[1] ?? '').length).toBeLessThan((prompts[0] ?? '').length);
    expect(result.summary).toContain('summary');
  });

  it('retries transient provider errors', async () => {
    const { resolved, completeSimple } = model([{ error: '503 service busy' }, { text: 'ok' }]);
    const result = await robustSummary(preparation(['hello']), resolved, {
      signal,
      retryDelayMs: 0,
    });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(result.summary.startsWith('ok')).toBe(true);
  });

  it('returns the local summary when the model summary fails', async () => {
    const { resolved } = model([{ error: 'invalid request' }]);
    const log = vi.fn();
    const result = await fallbackCompaction(
      preparation(['first ask', `second ask ${'q'.repeat(1_000)}`], 'older summary'),
      resolved,
      { signal, log }
    );
    expect(result.firstKeptEntryId).toBe('kept-1');
    expect(result.summary).toContain('compacted locally without a model');
    expect(result.summary).toContain('older summary');
    expect(result.summary.indexOf('first ask')).toBeLessThan(result.summary.indexOf('second ask'));
    expect(result.summary).not.toContain('q'.repeat(400));
    expect(result.summary).toContain('<modified-files>\nb.ts');
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('invalid request'));
  });

  it('does not fall back when the caller aborted', async () => {
    const { resolved } = model([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fallbackCompaction(preparation(['x']), resolved, { signal: controller.signal })
    ).rejects.toBeDefined();
  });
});
