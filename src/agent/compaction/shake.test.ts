import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { SHAKE_MARKER, shake } from './shake';
import type { CompactionContext } from './types';

const big = (label: string) => `${label}\n${'data '.repeat(2_000)}`; // ~2.5k tokens

function history() {
  const manager = SessionManager.inMemory('/tmp');
  const read = (id: string, path: string, output: string) => {
    manager.appendMessage(
      fauxAssistantMessage(fauxToolCall('read', { path }, { id }), { stopReason: 'toolUse' })
    );
    return manager.appendMessage({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read',
      content: [{ type: 'text', text: output }],
      isError: false,
      timestamp: 0,
    });
  };
  manager.appendMessage({ role: 'user', content: 'please read the files', timestamp: 0 });
  const first = read('c1', 'a.ts', big('first read of a'));
  const other = read('c2', 'b.ts', big('read of b'));
  const second = read('c3', 'a.ts', big('second read of a'));
  manager.appendMessage(fauxAssistantMessage('all read'));
  manager.appendMessage({ role: 'user', content: 'thanks', timestamp: 0 });
  return { manager, first, other, second };
}

function context(manager: SessionManager, tokensBefore: number, aggressive = false) {
  return {
    preparation: {
      firstKeptEntryId: 'unused',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
    } as never,
    model: { model: { contextWindow: 10_000 } } as never,
    sessionManager: manager,
    signal: new AbortController().signal,
    aggressive,
  } satisfies CompactionContext;
}

describe('shake compaction', () => {
  it('elides superseded reads first, in place, with a recoverable placeholder', async () => {
    const { manager, first, other, second } = history();
    // Threshold 9000, band 7200: dropping one ~2.5k result from 9.5k is enough.
    const result = await shake(context(manager, 9_500));
    expect(result).not.toBe('skip');
    if (result === 'skip') return;
    const edits = manager.getEntries().filter((e) => e.type === 'context_edit');
    expect(edits.map((e) => e.type === 'context_edit' && e.targetId)).toEqual([first]);
    const text = JSON.stringify(edits[0]);
    expect(text).toContain(SHAKE_MARKER);
    expect(text).toContain('read(');
    expect(text).toContain('a.ts');
    expect(text).toContain('Re-run the tool or re-read the file');
    expect(result.estimatedTokensAfter).toBeLessThan(9_500);
    // Committing the result keeps the whole (edited) history.
    manager.appendCompaction(result.summary, result.firstKeptEntryId, 9_500, result.details, true);
    const projected = JSON.stringify(manager.buildSessionProjection().messages);
    expect(projected).not.toContain('first read of a');
    expect(projected).toContain('read of b');
    expect(projected).toContain('second read of a');
    expect(projected).toContain('please read the files');
    expect(projected).toContain('all read');
    expect([other, second]).not.toContain(first);
  });

  it('skips without editing when eliding cannot reach the target', async () => {
    const { manager } = history();
    expect(await shake(context(manager, 50_000))).toBe('skip');
    expect(manager.getEntries().some((e) => e.type === 'context_edit')).toBe(false);
  });

  it('never touches the protected recent tail; the aggressive pass accepts less headroom', async () => {
    const { manager, second } = history();
    // Eliding both older results ends near 8.1k: above the 7.2k band, under the 9k threshold.
    expect(await shake(context(manager, 13_000))).toBe('skip');
    expect(await shake(context(manager, 13_000, true))).not.toBe('skip');
    const targets = manager
      .getEntries()
      .flatMap((e) => (e.type === 'context_edit' ? [e.targetId] : []));
    expect(targets).toHaveLength(2);
    expect(targets).not.toContain(second);
  });
});
