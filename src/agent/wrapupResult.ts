import type { CompactionState } from '@fynvra/core';

export type WrapupResult =
  | { ok: true; outcome: NonNullable<CompactionState['outcome']> }
  | { ok: false; errorMessage: string };

/** Plugin status texts that are progress, not the command's result. */
const PROGRESS = /^(Eligible history is about|Chunk \d+:)|^\/ctx-wrapup is still running\./;

/**
 * The result of Magic's `/ctx-wrapup` from the status texts it sent (vendored `runPiWrapup` and
 * `registerCtxWrapupCommand`), as counts. The last non-progress text is the command's result.
 */
export function parseWrapupResult(texts: readonly string[]): WrapupResult {
  const text = texts.findLast((item) => {
    const body = stripHeadings(item);
    return body && !PROGRESS.test(body);
  });
  if (!text) return { ok: false, errorMessage: 'Magic Context returned no result.' };
  const body = stripHeadings(text);
  if (body.startsWith('Nothing to wrap up')) return done(0);
  const wrapped = /wrapped up (\d+) messages into \d+ compartments/i.exec(body);
  if (wrapped) {
    const count = Number(wrapped[1]);
    // A partial run with progress still published its compartments.
    if (count > 0) return done(count);
    // Nothing eligible yet is not a failure.
    if (!/^#+ .*Partial/m.test(text) || body.startsWith('No runnable wrapup boundary'))
      return done(0);
    const reason = body.slice(body.indexOf(';') + 1).trim();
    return failed(reason || body);
  }
  return failed(body);
}

function stripHeadings(text: string): string {
  return text.replace(/^#+ .*$/gm, '').trim();
}

function done(compactedMessages: number): WrapupResult {
  return { ok: true, outcome: { compactedMessages, appliesOnNextMessage: compactedMessages > 0 } };
}

function failed(text: string): WrapupResult {
  // One line, within the protocol's 300-character limit.
  const line = text.split('\n')[0]?.trim() || text;
  return { ok: false, errorMessage: line.length > 300 ? `${line.slice(0, 299)}…` : line };
}
