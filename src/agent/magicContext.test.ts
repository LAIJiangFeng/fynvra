import type { ResolvedModel } from '@fynvra/agent-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMagicContextCompaction } from './magicContext';

type Runner = (options: Record<string, unknown>) => Promise<{ ok: boolean; transient?: boolean }>;
type Budget = (
  sessionId: string,
  systemPrompt: string,
  requestedMax?: number
) => { inputBytes: number; maxTokens: number } | undefined;

const globals = globalThis as unknown as Record<symbol, unknown>;
const run = (options: Record<string, unknown>) =>
  (globals[Symbol.for('fynvra.magic-context.subagent-runner')] as Runner)(options);
const budget: Budget = (...args) =>
  (globals[Symbol.for('fynvra.magic-context.historian-budget')] as Budget)(...args);

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

let nextId = 0;
function setup(answer: Record<string, unknown>, model: Record<string, unknown> = {}) {
  const completeSimple = vi.fn(async (..._args: unknown[]) => ({ content: [], ...answer }));
  const resolved = {
    runtime: { completeSimple },
    model: { provider: 'relay', id: 'm', contextWindow: 100_000, maxTokens: 32_000, ...model },
  } as unknown as ResolvedModel;
  const onFallback = vi.fn();
  const magic = createMagicContextCompaction(() => resolved, { onFallback });
  const sessionId = `magic-test-${nextId++}`;
  magic.attach(sessionId);
  disposers.push(() => magic.dispose());
  const call = () =>
    run({
      agent: 'historian',
      systemPrompt: '',
      userMessage: 'summarize',
      accountingSessionId: sessionId,
    });
  return { sessionId, completeSimple, onFallback, call };
}

describe('Magic Context historian host', () => {
  it('budgets bytes at 2 bytes/token within 80% of the window', () => {
    const { sessionId } = setup({ stopReason: 'stop' });
    // maxTokens = 0.2 * 100k; framing = 5% of 100k; input = (80k - 5k - 20k) tokens * 2 bytes.
    expect(budget(sessionId, '', 32_000)).toEqual({ inputBytes: 110_000, maxTokens: 20_000 });
  });

  it('halves the budget on provider context overflow and retries as transient', async () => {
    const { sessionId, onFallback, call } = setup({
      stopReason: 'error',
      errorMessage: "400 This model's maximum context length is 65536 tokens",
    });
    expect(await call()).toMatchObject({ ok: false, transient: true });
    expect(budget(sessionId, '', 32_000)?.inputBytes).toBe(55_000);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('stops shrinking at the minimum budget and then suspends', async () => {
    const { sessionId, onFallback, call } = setup({
      stopReason: 'error',
      errorMessage: 'context_length_exceeded',
    });
    for (let i = 0; i < 20 && !onFallback.mock.calls.length; i++) await call();
    expect(onFallback).toHaveBeenCalledWith('runtime');
    expect(budget(sessionId, '', 32_000)).toBeUndefined();
  });

  it('treats an output-length stop as transient, suspending after three in a row', async () => {
    const { onFallback, call } = setup({ stopReason: 'length' });
    expect(await call()).toMatchObject({ ok: false, transient: true });
    await call();
    expect(onFallback).not.toHaveBeenCalled();
    await call();
    expect(onFallback).toHaveBeenCalledWith('runtime');
  });

  it('retries a Chinese relay rate-limit message but suspends on 401', async () => {
    const limited = setup({ stopReason: 'error', errorMessage: '当前请求过于频繁，请稍后再试' });
    expect(await limited.call()).toMatchObject({ transient: true });
    expect(limited.onFallback).not.toHaveBeenCalled();

    const denied = setup({ stopReason: 'error', errorMessage: '401 Unauthorized: invalid key' });
    expect(await denied.call()).toMatchObject({ transient: false });
    expect(denied.onFallback).toHaveBeenCalledWith('runtime');
  });

  it('requests the lowest reasoning only when the model cannot disable it', async () => {
    const optional = setup({ stopReason: 'stop' }, { reasoning: true });
    await optional.call();
    expect(optional.completeSimple.mock.calls[0]?.[2]).not.toHaveProperty('reasoning');

    const forced = setup(
      { stopReason: 'stop' },
      { reasoning: true, thinkingLevelMap: { off: null } }
    );
    await forced.call();
    expect(forced.completeSimple.mock.calls[0]?.[2]).toMatchObject({ reasoning: 'minimal' });
  });
});
