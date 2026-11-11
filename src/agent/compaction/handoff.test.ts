import type { CompactionResult } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { handoff } from './handoff';
import { runCompactionChain } from './methods';
import type { CompactionContext } from './types';

function resolved(completeSimple: (...args: never[]) => unknown): ResolvedModel {
  return {
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
}

function context(model: ResolvedModel): CompactionContext {
  return {
    preparation: {
      firstKeptEntryId: 'kept-1',
      messagesToSummarize: [{ role: 'user', content: 'refactor parser.ts', timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 9_000,
      fileOps: { read: new Set(), written: new Set(['parser.ts']), edited: new Set() },
      settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
    } as never,
    model,
    sessionManager: undefined as never,
    signal: new AbortController().signal,
    aggressive: false,
    retryDelayMs: 0,
  };
}

describe('handoff compaction', () => {
  it('uses the handoff document as the compaction summary', async () => {
    const completeSimple = vi.fn(async (_model: unknown, request: { systemPrompt: string }) => {
      expect(request.systemPrompt).toContain('handoff');
      return {
        role: 'assistant',
        content: [{ type: 'text', text: '## Goal\nRefactor parser' }],
        stopReason: 'stop',
      };
    });
    const result = await handoff(context(resolved(completeSimple)));
    expect(result.summary).toContain('## Goal\nRefactor parser');
    expect(result.summary).toContain('<modified-files>\nparser.ts');
    expect(result).toMatchObject({ firstKeptEntryId: 'kept-1', tokensBefore: 9_000 });
  });

  it('falls through to the next method when it throws', async () => {
    const completeSimple = vi.fn(async () => {
      throw new Error('invalid request');
    });
    const next: CompactionResult = { summary: 's', firstKeptEntryId: 'k', tokensBefore: 9_000 };
    const shake = vi.fn(async () => next);
    const { aggressive: _, ...ctx } = context(resolved(completeSimple));
    expect(await runCompactionChain(ctx, { handoff, shake })).toBe(next);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(shake).toHaveBeenCalledTimes(1);
  });
});
