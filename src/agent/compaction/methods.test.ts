import type { CompactionResult } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { CompactionChainError, runCompactionChain } from './methods';
import type { CompactionMethodFn } from './types';

const result = (after: number): CompactionResult => ({
  summary: 's',
  firstKeptEntryId: 'k',
  tokensBefore: 1_000,
  estimatedTokensAfter: after,
});

function ctx(signal = new AbortController().signal) {
  return {
    preparation: { tokensBefore: 1_000 } as never,
    model: undefined as never,
    sessionManager: undefined as never,
    signal,
  };
}

describe('compaction method chain', () => {
  it('moves to the next method on skip, error or no reduction, in the default order', async () => {
    const calls: string[] = [];
    const method =
      (name: string, outcome: () => Promise<CompactionResult | 'skip'>): CompactionMethodFn =>
      async ({ aggressive }) => {
        calls.push(`${name}${aggressive ? '!' : ''}`);
        return outcome();
      };
    const log = vi.fn();
    const found = await runCompactionChain(
      { ...ctx(), log },
      {
        soft: method('soft', async () => result(500)),
        shake: method('shake', async () => 'skip'),
        handoff: method('handoff', async () => {
          throw new Error('provider said: secret');
        }),
        snapcompact: method('snapcompact', async () => result(1_000)),
      }
    );
    expect(calls).toEqual(['snapcompact', 'handoff', 'shake', 'soft']);
    expect(found.estimatedTokensAfter).toBe(500);
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret');
  });

  it('runs one aggressive pass, then fails without locking anything', async () => {
    const calls: string[] = [];
    const methods = {
      shake: (async ({ aggressive }) => {
        calls.push(`shake${aggressive ? '!' : ''}`);
        return 'skip';
      }) satisfies CompactionMethodFn,
      soft: (async ({ aggressive }) => {
        calls.push(`soft${aggressive ? '!' : ''}`);
        throw new Error('down');
      }) satisfies CompactionMethodFn,
    };
    await expect(runCompactionChain(ctx(), methods)).rejects.toBeInstanceOf(CompactionChainError);
    expect(calls).toEqual(['shake', 'soft', 'shake!', 'soft!']);
  });

  it('stops at once when the caller aborted', async () => {
    const controller = new AbortController();
    const soft = vi.fn<CompactionMethodFn>(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(runCompactionChain(ctx(controller.signal), { soft })).rejects.not.toBeInstanceOf(
      CompactionChainError
    );
    expect(soft).toHaveBeenCalledTimes(1);
  });
});
