import type { ResolvedModel } from '@fynvra/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { soft } from './soft';
import type { CompactionContext } from './types';

type Reply = { text?: string; error?: string };

function fakeModel(replies: Reply[], contextWindow = 10_000) {
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
      contextWindow,
      maxTokens: 1_000,
      reasoning: false,
    },
  } as unknown as ResolvedModel;
  return { resolved, prompts, completeSimple };
}

function context(model: ResolvedModel, texts: string[]): CompactionContext {
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
      tokensBefore: 123_456,
      fileOps: { read: new Set(['a.ts', 'b.ts']), written: new Set(['b.ts']), edited: new Set() },
      settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
    } as never,
    model,
    sessionManager: undefined as never,
    signal: new AbortController().signal,
    aggressive: false,
    retryDelayMs: 0,
  };
}

describe('soft compaction (robust summary)', () => {
  it('folds an oversized history into windows that carry the summary forward', async () => {
    const { resolved, prompts } = fakeModel([{ text: 'S1' }, { text: 'S2' }, { text: 'S3' }]);
    const texts = Array.from({ length: 6 }, (_, i) => `request-${i} ${'x'.repeat(4_000)}`);
    const result = await soft(context(resolved, texts));
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).not.toContain('<previous-summary>');
    expect(prompts[1]).toContain('<previous-summary>\nS1\n');
    expect(prompts.join('')).toContain('request-5');
    expect(result).toMatchObject({ firstKeptEntryId: 'kept-1', tokensBefore: 123_456 });
    expect(result.summary).toContain(`S${prompts.length}`);
    expect(result.estimatedTokensAfter).toBeLessThan(123_456);
    expect(result.details).toEqual({ readFiles: ['a.ts'], modifiedFiles: ['b.ts'] });
  });

  it('truncates a single oversized message instead of failing', async () => {
    const { resolved, prompts } = fakeModel([{ text: 'short' }]);
    const result = await soft(context(resolved, ['y'.repeat(200_000)]));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('truncated for compaction');
    expect(Buffer.byteLength(prompts[0] ?? '')).toBeLessThan(16_000);
    expect(result.summary).toContain('short');
  });

  it('halves the window budget after a provider context overflow, then succeeds', async () => {
    const { resolved, prompts } = fakeModel([
      { error: 'context_length_exceeded: maximum context length' },
    ]);
    const texts = Array.from({ length: 4 }, (_, i) => `m${i} ${'z'.repeat(2_000)}`);
    await soft(context(resolved, texts));
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect((prompts[1] ?? '').length).toBeLessThan((prompts[0] ?? '').length);
  });

  it('retries transient provider errors, but not permanent ones', async () => {
    const transient = fakeModel([{ error: '503 service busy' }, { text: 'ok' }]);
    const result = await soft(context(transient.resolved, ['hello']));
    expect(transient.completeSimple).toHaveBeenCalledTimes(2);
    expect(result.summary.startsWith('ok')).toBe(true);
    const permanent = fakeModel([{ error: 'invalid request: secret prompt text' }]);
    await expect(soft(context(permanent.resolved, ['hello']))).rejects.toThrow(
      'summary request failed'
    );
    expect(permanent.completeSimple).toHaveBeenCalledTimes(1);
  });
});
