import { describe, expect, it } from 'vitest';
import { parseWrapupResult } from './wrapupResult';

// Texts as the vendored magic-context `runPiWrapup` / `registerCtxWrapupCommand` send them.
const ELIGIBLE = `## Magic Wrapup

Eligible history is about 41,200 tokens across approximately 2 historian chunk(s).`;
const CHUNK = `## Magic Wrapup

Chunk 1: wrapping messages 0-57 (~41,200 eligible tokens remain).`;
const ok = (compactedMessages: number) => ({
  ok: true,
  outcome: { compactedMessages, appliesOnNextMessage: compactedMessages > 0 },
});

describe('parseWrapupResult', () => {
  it('reads a full wrapup as compacted messages applying on the next message', () => {
    const result = `## Magic Wrapup

Wrapped up 58 messages into 3 compartments. The compacted history is queued and materializes on your next message.`;
    expect(parseWrapupResult([ELIGIBLE, CHUNK, result])).toEqual(ok(58));
    expect(
      parseWrapupResult([result, '/ctx-wrapup is still running. Press Stop to cancel.'])
    ).toEqual(ok(58));
  });

  it('treats nothing to wrap up and no runnable boundary as success with 0', () => {
    expect(
      parseWrapupResult([
        `## Magic Wrapup

Nothing to wrap up — only 4 messages above the last compartment.`,
      ])
    ).toEqual(ok(0));
    expect(
      parseWrapupResult([
        `## Magic Wrapup — Partial

No runnable wrapup boundary is available yet; wrapped up 0 messages into 0 compartments. Run /ctx-wrapup again to continue.`,
      ])
    ).toEqual(ok(0));
  });

  it('counts a partial wrapup that made progress as success', () => {
    expect(
      parseWrapupResult([
        ELIGIBLE,
        CHUNK,
        `## Magic Wrapup — Partial

Wrapped up 30 messages into 2 compartments; No forward progress after chunk 2; wrapped up through message 30. Run /ctx-wrapup again to continue.`,
      ])
    ).toEqual(ok(30));
  });

  it('reports a partial wrapup without progress as a one-line failure', () => {
    expect(
      parseWrapupResult([
        ELIGIBLE,
        `## Magic Wrapup — Partial

Wrapped up 0 messages into 0 compartments; Timed out waiting for another process to release the compartment-state lease; wrapped up through message 12. Run /ctx-wrapup again to continue.`,
      ])
    ).toEqual({
      ok: false,
      errorMessage:
        'Timed out waiting for another process to release the compartment-state lease; wrapped up through message 12. Run /ctx-wrapup again to continue.',
    });
  });

  it('reports skipped, unavailable and thrown commands as failures without headings', () => {
    expect(
      parseWrapupResult([
        `## Magic Wrapup — Skipped

Another /ctx-wrapup is already compacting this session. Wait for it to finish, then try again.`,
      ])
    ).toEqual({
      ok: false,
      errorMessage:
        'Another /ctx-wrapup is already compacting this session. Wait for it to finish, then try again.',
    });
    expect(
      parseWrapupResult([
        `## Magic Wrapup

/ctx-wrapup is unavailable because the active harness's historian model is not configured.`,
      ])
    ).toEqual({
      ok: false,
      errorMessage:
        "/ctx-wrapup is unavailable because the active harness's historian model is not configured.",
    });
    expect(parseWrapupResult(['/ctx-wrapup failed: database is locked'])).toEqual({
      ok: false,
      errorMessage: '/ctx-wrapup failed: database is locked',
    });
    expect(parseWrapupResult([])).toMatchObject({ ok: false });
    expect(parseWrapupResult([ELIGIBLE])).toMatchObject({ ok: false });
  });

  it('keeps the error within the protocol limit', () => {
    const result = parseWrapupResult([`/ctx-wrapup failed: ${'x'.repeat(500)}`]);
    expect(result.ok === false && result.errorMessage.length).toBe(300);
  });
});
