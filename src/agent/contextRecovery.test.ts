import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createRoleSession, subscribeNormalized } from '@fynvra/agent-runtime';
import type { ContextRuntimeSnapshot, FynvraSessionEvent } from '@fynvra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectHistory } from '../main/services/sessions/history';
import { createCompactionChainExtension } from './compaction/methods';
import { createContextRecovery } from './contextRecovery';

interface Extra {
  /** Stand-in for magic.assertReady(): may switch the gate to fallback and throw, like piSession. */
  magicReady?: (fallBack: () => void) => AbortSignal;
  /** Install the compaction method chain as the session's compaction hook. */
  chain?: boolean;
  /** Chain active only during a manual compaction (the off strategy's wiring in piSession). */
  manualChain?: boolean;
  extensions?: InlineExtension[];
  beforeOpen?: (manager: SessionManager) => void;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function setup(
  seed = true,
  maxRetries = 0,
  strategy: 'native' | 'magic-context' | 'off' = 'native',
  extra: Extra = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'fynvra-context-'));
  const faux = fauxProvider({
    provider: 'context-test',
    // Text-only, so the chain reaches shake/soft (snapcompact needs image input).
    models: [{ id: 'context-test', contextWindow: 10_000, maxTokens: 1000, input: ['text'] }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const manager = SessionManager.open(join(dir, 'session.jsonl'), dir, dir);
  if (seed)
    for (let i = 0; i < 6; i++) {
      manager.appendMessage({
        role: 'user',
        content: `old-${i} ${'history '.repeat(4000)}`,
        timestamp: i,
      });
      const answer = fauxAssistantMessage(`old-answer-${i}`);
      answer.usage = { ...answer.usage, input: 9000, output: 20, totalTokens: 9020 };
      manager.appendMessage(answer);
    }
  extra.beforeOpen?.(manager);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const resolved = { runtime, model: faux.getModel() };
  let current = manager;
  let chainActive = () => true;
  const options: Parameters<typeof createRoleSession>[0] = {
    role: {
      id: 'worker',
      name: 'worker',
      tools: 'readonly',
      approvalMode: 'full',
      skillIds: [],
      mcpServerIds: [],
    },
    cwd: dir,
    agentDir: dir,
    host: null,
    model: resolved,
    sessionManager: manager,
    resourcePaths: { skills: [], mcpServers: [] },
    extensions: [
      ...(extra.chain || extra.manualChain
        ? [
            createCompactionChainExtension({
              getModel: () => resolved,
              getSessionManager: () => current,
              active: () => chainActive(),
            }),
          ]
        : []),
      ...(extra.extensions ?? []),
    ],
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: strategy !== 'magic-context',
        reserveTokens: 2000,
        keepRecentTokens: 500,
      },
      retry: { enabled: maxRetries > 0, maxRetries, baseDelayMs: 1000 },
      enableInstallTelemetry: false,
    }),
  };
  const created = await createRoleSession(options);
  const monitored = monitor(created, strategy, extra.magicReady);
  if (extra.manualChain) chainActive = () => monitored.recovery.manualCompacting();
  return {
    ...monitored,
    manager,
    faux,
    dir,
    reopen: async () => {
      await monitored.dispose();
      const restoredManager = SessionManager.open(join(dir, 'session.jsonl'), dir, dir);
      current = restoredManager;
      return {
        ...monitor(
          await createRoleSession({ ...options, sessionManager: restoredManager }),
          strategy,
          extra.magicReady
        ),
        manager: restoredManager,
      };
    },
  };
}
function monitor(
  created: Awaited<ReturnType<typeof createRoleSession>>,
  strategy: 'native' | 'magic-context' | 'off' = 'native',
  magicReady?: Extra['magicReady']
) {
  const session = created.session;
  const events: FynvraSessionEvent[] = [];
  const recovery = createContextRecovery({
    session,
    strategy,
    timeoutMs: 30_000,
    contextWindow: () => session.model?.contextWindow ?? 0,
    log: () => {},
    ...(magicReady ? { magicReady: () => magicReady(() => recovery.fallBack()) } : {}),
  });
  const subscription = subscribeNormalized(
    session,
    (event) => {
      events.push(event);
      recovery.onEvent(event);
    },
    { compactionTimeoutMs: 30_000 }
  );
  recovery.bind(subscription);
  const dispose = async () => {
    recovery.dispose();
    await created.dispose();
    subscription.unsubscribe();
  };
  cleanup.push(dispose);
  const latest = (): ContextRuntimeSnapshot => {
    const event = events.findLast((event) => event.type === 'context_runtime');
    if (event?.type !== 'context_runtime') throw new Error('missing snapshot');
    return event.snapshot;
  };
  return { recovery, session, events, latest, dispose };
}
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

/** A recovery lock written by an earlier Fynvra version (fail-closed compaction). */
function legacyLock(options: { written?: string; pending?: string[] }) {
  return (manager: SessionManager) => {
    if (options.written) {
      manager.appendMessage({ role: 'user', content: options.written, timestamp: 100 });
    }
    manager.appendCustomEntry('fynvra-context-recovery', {
      blocked: true,
      resume: Boolean(options.written),
      pending: (options.pending ?? []).map((text) => ({ text })),
    });
  };
}
const usersIn = (manager: SessionManager, text: string) =>
  manager
    .getEntries()
    .filter(
      (e) => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e).includes(text)
    );
const compactionsIn = (manager: SessionManager) =>
  manager.getEntries().filter((e) => e.type === 'compaction');
const FAILED = 'Context compaction failed; the conversation is kept. Send a message to try again.';

describe('compaction failures end the turn without locking the session', () => {
  it('a timeout aborts downstream, rejects late summaries and sends no oversized request', async () => {
    const env = await setup(true, 2);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let signal: AbortSignal | undefined;
    const late = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 unavailable' }),
      (_context, options) => {
        signal = options?.signal;
        return late.promise;
      },
    ]);
    const run = env.recovery.prompt('new-input');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(signal).toBeDefined();
    const operation = env.latest().compaction;
    expect(operation?.phase).toBe('running');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(signal?.aborted).toBe(true);
    late.resolve(fauxAssistantMessage('late summary'));
    await run;
    expect(env.latest()).toMatchObject({
      recoveryRequired: false,
      compaction: { phase: 'cancelled', cancelSource: 'timeout', startedAt: operation?.startedAt },
    });
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.faux.state.callCount).toBe(2); // No oversized request after the failed compaction.
    expect(env.events.some((e) => e.type === 'error' && e.message === FAILED)).toBe(true);
    vi.useRealTimers();
    // The next message triggers compaction again.
    env.faux.setResponses([fauxAssistantMessage('valid summary'), fauxAssistantMessage('answer')]);
    await env.recovery.prompt('next-input');
    expect(compactionsIn(env.manager)).toHaveLength(1);
    expect(usersIn(env.manager, 'next-input')).toHaveLength(1);
    expect(env.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
    const seqs = env.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const file = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    expect(file).toContain('old-answer-0');
    expect(file).not.toContain('late summary');
  });

  it('reports a final failure after bounded retries; the next message compacts again', async () => {
    const env = await setup(true, 1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 unavailable' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 unavailable' }),
    ]);
    const run = env.recovery.prompt('first');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    vi.useRealTimers();
    expect(env.faux.state.callCount).toBe(2);
    expect(env.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
    expect(env.events.some((e) => e.type === 'error' && e.message === FAILED)).toBe(true);
    env.faux.setResponses([fauxAssistantMessage('summary'), fauxAssistantMessage('answer')]);
    await env.recovery.prompt('second');
    expect(usersIn(env.manager, 'second')).toHaveLength(1);
    expect(compactionsIn(env.manager)).toHaveLength(1);
    expect(env.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
    await expect(env.recovery.retryCompaction()).rejects.toThrow('No compaction recovery');
  });

  it('stops the tool loop after a failed between-turn compaction instead of sending the old projection', async () => {
    const env = await setup(false);
    const path = join(env.dir, 'large.txt');
    await writeFile(path, Array.from({ length: 100 }, () => 'word '.repeat(90)).join('\n'));
    env.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid summary response' }),
    ]);
    await env.recovery.prompt('read the file');
    expect(env.latest()).toMatchObject({
      recoveryRequired: false,
      compaction: { phase: 'failed', reason: 'threshold' },
    });
    expect(env.faux.state.callCount).toBe(2);
    expect(compactionsIn(env.manager)).toHaveLength(0);
    env.faux.setResponses([
      fauxAssistantMessage('summary of the completed read'),
      fauxAssistantMessage('recovered'),
    ]);
    await env.recovery.prompt('continue');
    const jsonl = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    expect(jsonl).toContain('recovered');
    expect(compactionsIn(env.manager)).toHaveLength(1);
    expect(env.latest().recoveryRequired).toBe(false);
  });

  it('Stop cancels without automatic resurrection and leaves the old transcript intact', async () => {
    const env = await setup();
    const late = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let signal: AbortSignal | undefined;
    env.faux.setResponses([
      (_context, options) => {
        signal = options?.signal;
        return late.promise;
      },
    ]);
    const run = env.recovery.prompt('stopped input');
    await flush();
    expect(signal).toBeDefined();
    const abort = env.recovery.abort();
    expect(signal?.aborted).toBe(true);
    late.resolve(fauxAssistantMessage('cancelled result'));
    await Promise.all([run, abort]);
    expect(env.latest()).toMatchObject({
      recoveryRequired: false,
      compaction: { phase: 'cancelled', cancelSource: 'user' },
    });
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.faux.state.callCount).toBe(1);
    expect(env.events.some((e) => e.type === 'error' && e.message === FAILED)).toBe(false);
  });

  it('cancels downstream on shutdown and discards late results', async () => {
    const env = await setup();
    const late = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let signal: AbortSignal | undefined;
    env.faux.setResponses([
      (_context, options) => {
        signal = options?.signal;
        return late.promise;
      },
    ]);
    const run = env.recovery.prompt('closing');
    await flush();
    env.recovery.dispose();
    expect(signal?.aborted).toBe(true);
    const eventCount = env.events.length;
    late.resolve(fauxAssistantMessage('late on shutdown'));
    await run;
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.events.slice(eventCount).some((e) => e.type === 'context_runtime')).toBe(false);
  });

  it('preserves short turns and the actual context window with explicit native compaction', async () => {
    const env = await setup(false);
    env.faux.setResponses([fauxAssistantMessage('short answer')]);
    await env.recovery.prompt('short input');
    expect(env.latest()).toMatchObject({
      configuredStrategy: 'native',
      effectiveStrategy: 'native',
      recoveryRequired: false,
      pendingPromptCount: 0,
      context: { contextWindow: 10_000, compactionThresholdTokens: 8000 },
    });
    expect(env.events.filter((e) => e.type === 'agent_settled')).toHaveLength(1);
    expect(env.latest().compaction).toBeUndefined();
  });
});

describe('legacy recovery locks from fail-closed versions stay recoverable', () => {
  it('restores the lock and unconsumed input from pi jsonl and resumes exactly once', async () => {
    const env = await setup(true, 0, 'native', {
      beforeOpen: legacyLock({ written: 'already written', pending: ['held across restart'] }),
    });
    expect(env.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 1 });
    const restored = await env.reopen();
    expect(restored.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 1 });
    env.faux.setResponses([
      fauxAssistantMessage('summary after restart'),
      fauxAssistantMessage('resumed'),
      fauxAssistantMessage('answer after restart'),
    ]);
    await restored.recovery.retryCompaction();
    expect(usersIn(restored.manager, 'already written')).toHaveLength(1);
    expect(usersIn(restored.manager, 'held across restart')).toHaveLength(1);
    expect(restored.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
    await expect(restored.recovery.retryCompaction()).rejects.toThrow('No compaction recovery');
  });

  it('keeps durable recovery when unloaded immediately after summary commit, before resumption', async () => {
    const env = await setup(true, 0, 'native', {
      beforeOpen: legacyLock({ written: 'original before resume' }),
    });
    env.faux.setResponses([fauxAssistantMessage('committed summary')]);
    const unsubscribe = env.session.subscribe((event) => {
      if (event.type === 'compaction_end' && event.result && !event.aborted) env.recovery.dispose();
    });
    await env.recovery.retryCompaction();
    unsubscribe();
    expect(compactionsIn(env.manager)).toHaveLength(1);
    const restored = await env.reopen();
    expect(restored.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 0 });
    const compact = vi.spyOn(restored.session, 'compact');
    env.faux.setResponses([fauxAssistantMessage('resumed after reload')]);
    await restored.recovery.retryCompaction();
    expect(compact).not.toHaveBeenCalled();
    expect(compactionsIn(restored.manager)).toHaveLength(1);
    const history = projectHistory(await readFile(join(env.dir, 'session.jsonl'), 'utf8'), 's1');
    expect(
      history.filter((m) => m.role === 'user' && m.text === 'original before resume')
    ).toHaveLength(1);
    expect(restored.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
  });

  it('Stop during legacy recovery keeps the lock for a later explicit retry', async () => {
    const env = await setup(true, 0, 'native', {
      beforeOpen: legacyLock({ written: 'stopped resumed input' }),
    });
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    env.faux.setResponses([
      fauxAssistantMessage('committed summary'),
      () => {
        entered.resolve();
        return late.promise;
      },
    ]);
    const attempt = env.recovery.retryCompaction().catch(() => undefined);
    await entered.promise;
    const stopped = env.recovery.abort();
    late.resolve(fauxAssistantMessage('late interrupted answer'));
    await Promise.all([attempt, stopped]);
    expect(env.latest().recoveryRequired).toBe(true);
    env.faux.setResponses([fauxAssistantMessage('explicitly resumed')]);
    const compact = vi.spyOn(env.session, 'compact');
    await env.recovery.retryCompaction();
    expect(compact).not.toHaveBeenCalled();
    const history = projectHistory(await readFile(join(env.dir, 'session.jsonl'), 'utf8'), 's1');
    expect(
      history.filter((m) => m.role === 'user' && m.text === 'stopped resumed input')
    ).toHaveLength(1);
    expect(env.latest().recoveryRequired).toBe(false);
  });

  it('handles Stop in the public compact allocation gap without committing', async () => {
    const env = await setup(true, 0, 'native', {
      beforeOpen: legacyLock({ pending: ['pending'] }),
    });
    env.faux.setResponses([fauxAssistantMessage('must not commit')]);
    const attempt = env.recovery.retryCompaction().catch(() => undefined);
    const stop = env.recovery.abort();
    await Promise.all([attempt, stop]);
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.latest()).toMatchObject({
      recoveryRequired: true,
      compaction: { phase: 'cancelled', cancelSource: 'user' },
    });
  });
});

describe('Magic Context falls back to the compaction chain', () => {
  it('switches a stopped Magic session to the chain without locking it', async () => {
    let ready = true;
    const env = await setup(false, 0, 'magic-context', {
      magicReady: (fallBack) => {
        if (ready) return new AbortController().signal;
        fallBack();
        throw new Error('Magic Context is unavailable.');
      },
    });
    expect(env.latest()).toMatchObject({
      configuredStrategy: 'magic-context',
      effectiveStrategy: 'magic-context',
    });
    expect(env.latest().context.compactionThresholdTokens).toBeUndefined();
    expect(env.session.autoCompactionEnabled).toBe(false);
    env.faux.setResponses([
      fauxAssistantMessage('magic answer'),
      fauxAssistantMessage('fallback answer'),
    ]);
    await env.recovery.prompt('while magic works');
    // Magic stops at the next request: the request continues instead of being blocked.
    ready = false;
    await env.recovery.prompt('after magic stopped');
    expect(env.faux.state.callCount).toBe(2);
    expect(env.session.autoCompactionEnabled).toBe(true);
    expect(env.latest()).toMatchObject({
      configuredStrategy: 'magic-context',
      effectiveStrategy: 'native',
      recoveryRequired: false,
      pendingPromptCount: 0,
      context: { compactionThresholdTokens: 8000 },
    });
    const jsonl = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    expect(jsonl).toContain('after magic stopped');
    expect(jsonl).toContain('fallback answer');
    expect(env.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('recovers an old blocked Magic checkpoint through the method chain', async () => {
    const env = await setup(true, 0, 'magic-context', {
      chain: true,
      magicReady: (fallBack) => {
        fallBack();
        throw new Error('Magic Context is unavailable.');
      },
      beforeOpen: legacyLock({ pending: ['held before upgrade'] }),
    });
    expect(env.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 1 });
    // Shake has nothing to elide; the first soft summary fails for good, the aggressive pass works
    // (one summary request per history window).
    const respond = (context: { messages: unknown[] }) =>
      fauxAssistantMessage(
        JSON.stringify(context.messages).includes('<conversation>')
          ? 'chain summary'
          : 'answer after recovery'
      );
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid summary request' }),
      ...Array.from({ length: 40 }, () => respond),
    ]);
    await env.recovery.retryCompaction();
    expect(JSON.stringify(compactionsIn(env.manager))).toContain('chain summary');
    const jsonl = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    expect(jsonl).toContain('answer after recovery');
    expect(env.latest()).toMatchObject({
      effectiveStrategy: 'native',
      recoveryRequired: false,
      pendingPromptCount: 0,
    });
  });
});

describe('manual compaction', () => {
  // The chain's soft summary request contains `<conversation>`; anything else is an ordinary turn.
  const chainSummary = () =>
    Array.from(
      { length: 40 },
      () => (context: { messages: unknown[] }) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes('<conversation>') ? 'chain summary' : 'answer'
        )
    );
  type Notifying = { ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void } };
  const wrapup = (handler: (args: string, ctx: Notifying) => Promise<void>): InlineExtension => ({
    name: 'fake-magic',
    hidden: true,
    factory: (pi) => pi.registerCommand('ctx-wrapup', { description: 'test', handler }),
  });

  it('native compacts through the method chain with reason manual', async () => {
    const env = await setup(true, 0, 'native', { chain: true });
    env.faux.setResponses(chainSummary());
    await env.recovery.compact();
    expect(compactionsIn(env.manager)).toMatchObject([{ fromHook: true }]);
    expect(JSON.stringify(compactionsIn(env.manager))).toContain('chain summary');
    expect(env.latest().compaction).toMatchObject({ phase: 'succeeded', reason: 'manual' });
    expect(env.recovery.isIdle()).toBe(true);
  });

  it('off compacts through the method chain, active only during the manual compaction', async () => {
    const env = await setup(true, 0, 'off', { manualChain: true });
    expect(env.recovery.manualCompacting()).toBe(false);
    env.faux.setResponses(chainSummary());
    await env.recovery.compact();
    // fromHook: the chain answered, not pi's default summary.
    expect(compactionsIn(env.manager)).toMatchObject([{ fromHook: true }]);
    expect(JSON.stringify(compactionsIn(env.manager))).toContain('chain summary');
    expect(env.recovery.manualCompacting()).toBe(false);
  });

  it('a Magic fallback compacts through the method chain', async () => {
    const env = await setup(true, 0, 'magic-context', {
      chain: true,
      magicReady: (fallBack) => {
        fallBack();
        throw new Error('Magic Context is unavailable.');
      },
    });
    env.faux.setResponses(chainSummary());
    await env.recovery.compact();
    expect(compactionsIn(env.manager)).toMatchObject([{ fromHook: true }]);
    expect(env.latest().effectiveStrategy).toBe('native');
  });

  const notifying =
    (text: string, level: 'info' | 'error' = 'info') =>
    async (_args: string, ctx: Notifying) => {
      ctx.ui.notify(text, level);
    };
  const magicEnv = (handler: (args: string, ctx: Notifying) => Promise<void>) =>
    setup(true, 0, 'magic-context', {
      chain: true,
      magicReady: () => new AbortController().signal,
      extensions: [wrapup(handler)],
    });
  // Neither the command echo nor the plugin's text reaches the chat.
  const noChatOutput = (events: FynvraSessionEvent[]) =>
    expect(events.filter((e) => ['command', 'command_end', 'notice'].includes(e.type))).toEqual([]);
  const compactions = (events: FynvraSessionEvent[]) =>
    events.flatMap((e) => (e.type === 'compaction' ? [e.state] : []));

  it('healthy Magic runs /ctx-wrapup as a manual compaction with a counted outcome', async () => {
    const handler = vi.fn(
      notifying(
        '## Magic Wrapup\n\nWrapped up 58 messages into 3 compartments. The compacted history is queued and materializes on your next message.'
      )
    );
    const env = await magicEnv(handler);
    const compact = vi.spyOn(env.session, 'compact');
    await env.recovery.compact();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
    const [running, done] = compactions(env.events);
    expect(running).toMatchObject({ reason: 'manual', phase: 'running' });
    expect(done).toMatchObject({
      operationId: running?.operationId,
      reason: 'manual',
      phase: 'succeeded',
      outcome: { compactedMessages: 58, appliesOnNextMessage: true },
    });
    expect(env.latest().compaction).toEqual(done);
    expect(env.latest().recoveryRequired).toBe(false);
    noChatOutput(env.events);
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.recovery.isIdle()).toBe(true);
  });

  it('nothing to wrap up succeeds with 0 compacted messages', async () => {
    const env = await magicEnv(
      notifying(
        '## Magic Wrapup — Partial\n\nNo runnable wrapup boundary is available yet; wrapped up 0 messages into 0 compartments. Run /ctx-wrapup again to continue.',
        'error'
      )
    );
    await env.recovery.compact();
    expect(env.latest().compaction).toMatchObject({
      phase: 'succeeded',
      outcome: { compactedMessages: 0, appliesOnNextMessage: false },
    });
    noChatOutput(env.events);
    expect(env.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a failed /ctx-wrapup ends the operation failed with the plugin reason', async () => {
    const env = await magicEnv(async () => {
      throw new Error('database is locked');
    });
    await expect(env.recovery.compact()).rejects.toThrow(FAILED);
    expect(env.latest().compaction).toMatchObject({
      reason: 'manual',
      phase: 'failed',
      errorMessage: '/ctx-wrapup failed: database is locked',
    });
    expect(env.latest().compaction).not.toHaveProperty('outcome');
    noChatOutput(env.events);
    expect(env.latest().recoveryRequired).toBe(false);
    expect(env.recovery.isIdle()).toBe(true);
  });

  it('Stop cancels a running /ctx-wrapup', async () => {
    const env = await magicEnv(() => new Promise(() => {}));
    const run = env.recovery.compact();
    await flush();
    expect(env.recovery.isIdle()).toBe(false);
    expect(env.latest().compaction).toMatchObject({ reason: 'manual', phase: 'running' });
    await env.recovery.abort();
    await expect(run).resolves.toBeUndefined();
    expect(env.recovery.isIdle()).toBe(true);
    expect(compactions(env.events).map((state) => state.phase)).toEqual(['running', 'cancelled']);
    expect(env.latest().compaction).toMatchObject({ phase: 'cancelled', cancelSource: 'user' });
    noChatOutput(env.events);
  });

  it('Stop cancels a native manual compaction without rewriting history', async () => {
    const env = await setup(true, 0, 'native', { chain: true });
    const pending = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    env.faux.setResponses(Array.from({ length: 40 }, () => () => pending.promise));
    const run = env.recovery.compact();
    await vi.waitFor(() => expect(env.latest().compaction?.phase).toBe('running'));
    await env.recovery.abort();
    pending.resolve(fauxAssistantMessage('late summary'));
    await expect(run).resolves.toBeUndefined();
    expect(compactionsIn(env.manager)).toHaveLength(0);
    expect(env.latest().compaction).toMatchObject({ cancelSource: 'user' });
    expect(env.recovery.isIdle()).toBe(true);
  });

  it('rejects while busy', async () => {
    const env = await setup(true, 0, 'native', { beforeOpen: legacyLock({}) });
    await expect(env.recovery.compact()).rejects.toThrow('busy');
  });
});
