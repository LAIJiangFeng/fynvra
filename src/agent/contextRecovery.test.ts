import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createRoleSession, subscribeNormalized } from '@fynvra/agent-runtime';
import type { ContextRuntimeSnapshot, FynvraSessionEvent } from '@fynvra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectHistory } from '../main/services/sessions/history';
import { createContextRecovery } from './contextRecovery';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function setup(
  seed = true,
  maxRetries = 0,
  strategy: 'native' | 'magic-context' | 'off' = 'native'
) {
  const dir = await mkdtemp(join(tmpdir(), 'fynvra-context-'));
  const faux = fauxProvider({
    provider: 'context-test',
    models: [{ id: 'context-test', contextWindow: 10_000, maxTokens: 1000 }],
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
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
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
    model: { runtime, model: faux.getModel() },
    sessionManager: manager,
    resourcePaths: { skills: [], mcpServers: [] },
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 500 },
      retry: { enabled: maxRetries > 0, maxRetries, baseDelayMs: 1000 },
      enableInstallTelemetry: false,
    }),
  };
  const created = await createRoleSession(options);
  const monitored = monitor(created, strategy);
  return {
    ...monitored,
    manager,
    faux,
    dir,
    reopen: async () => {
      await monitored.dispose();
      const restoredManager = SessionManager.open(join(dir, 'session.jsonl'), dir, dir);
      return {
        ...monitor(
          await createRoleSession({ ...options, sessionManager: restoredManager }),
          strategy
        ),
        manager: restoredManager,
      };
    },
  };
}
function monitor(
  created: Awaited<ReturnType<typeof createRoleSession>>,
  strategy: 'native' | 'magic-context' | 'off' = 'native'
) {
  const session = created.session;
  const events: FynvraSessionEvent[] = [];
  const recovery = createContextRecovery({
    session,
    strategy,
    timeoutMs: 30_000,
    contextWindow: () => session.model?.contextWindow ?? 0,
    log: () => {},
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

describe('native compaction recovery with the installed SDK and an offline provider', () => {
  it('really aborts downstream across retry/backoff, rejects late summary commits, and resumes an already written user exactly once', async () => {
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
    expect(env.latest()).toMatchObject({
      recoveryRequired: true,
      compaction: {
        phase: 'cancelled',
        cancelSource: 'timeout',
        startedAt: operation?.startedAt,
        durationMs: 30_000,
      },
    });
    late.resolve(fauxAssistantMessage('late summary'));
    await run;
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    expect(env.faux.state.callCount).toBe(2); // No large conversation request after failed preflight compaction.
    const before = env.manager
      .getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user');
    expect(before.filter((e) => JSON.stringify(e).includes('new-input'))).toHaveLength(1);
    env.faux.setResponses([
      fauxAssistantMessage('valid summary'),
      fauxAssistantMessage('recovered answer'),
    ]);
    await env.recovery.retryCompaction();
    const after = env.manager
      .getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user');
    expect(after).toHaveLength(before.length);
    expect(after.filter((e) => JSON.stringify(e).includes('new-input'))).toHaveLength(1);
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(1);
    expect(env.latest().recoveryRequired).toBe(false);
    expect(
      env.events.some(
        (e) =>
          e.type === 'context_runtime' &&
          e.snapshot.compaction?.phase === 'succeeded' &&
          e.snapshot.context.tokens === null
      )
    ).toBe(true);
    const seqs = env.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const file = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    expect(file).toContain('old-answer-0');
    expect(file).not.toContain('late summary');
  });

  it('blocks provider requests on final failure, retains unconsumed input, bounds retries, and retries only on explicit recovery', async () => {
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
    expect(env.faux.state.callCount).toBe(2);
    expect(env.latest().recoveryRequired).toBe(true);
    await env.recovery.prompt('unconsumed');
    expect(env.latest().pendingPromptCount).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(env.faux.state.callCount).toBe(2);
    env.faux.setResponses([
      fauxAssistantMessage('summary'),
      fauxAssistantMessage('answer'),
      fauxAssistantMessage('second answer'),
    ]);
    await env.recovery.retryCompaction();
    const users = env.manager
      .getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user');
    expect(users.filter((e) => JSON.stringify(e).includes('unconsumed'))).toHaveLength(1);
    expect(users.filter((e) => JSON.stringify(e).includes('first'))).toHaveLength(1);
    expect(env.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
    await expect(env.recovery.retryCompaction()).rejects.toThrow('No compaction recovery');
  });

  it('blocks the SDK between-turn old-projection path after a real tool response', async () => {
    const env = await setup(false);
    const path = join(env.dir, 'large.txt');
    await writeFile(path, Array.from({ length: 100 }, () => 'word '.repeat(90)).join('\n'));
    env.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid summary response' }),
    ]);
    await env.recovery.prompt('read the file');
    expect(env.latest()).toMatchObject({
      recoveryRequired: true,
      compaction: { phase: 'failed', reason: 'threshold' },
    });
    expect(env.faux.state.callCount).toBe(2);
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    env.faux.setResponses([
      fauxAssistantMessage('summary of the completed read'),
      fauxAssistantMessage('recovered'),
    ]);
    await env.recovery.retryCompaction();
    const jsonl = await readFile(join(env.dir, 'session.jsonl'), 'utf8');
    const projected = projectHistory(jsonl, 's1');
    expect(projected.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'read the file',
    ]);
    expect(projected.some((m) => m.text.includes('Context compaction completed'))).toBe(false);
    expect(
      env.manager
        .getEntries()
        .filter((e) => e.type === 'custom_message' && e.customType === 'fynvra-compaction-resume')
    ).toHaveLength(1);
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
      recoveryRequired: true,
      compaction: { phase: 'cancelled', cancelSource: 'user' },
    });
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    expect(env.faux.state.callCount).toBe(1);
  });

  it('restores the failure gate and unconsumed input from pi jsonl across session disposal', async () => {
    const env = await setup();
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary unavailable' }),
    ]);
    await env.recovery.prompt('already written');
    await env.recovery.prompt('held across restart');
    const restored = await env.reopen();
    expect(restored.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 1 });
    env.faux.setResponses([
      fauxAssistantMessage('summary after restart'),
      fauxAssistantMessage('answer after restart'),
    ]);
    await restored.recovery.retryCompaction();
    const users = restored.manager
      .getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user');
    expect(users.filter((e) => JSON.stringify(e).includes('already written'))).toHaveLength(1);
    expect(users.filter((e) => JSON.stringify(e).includes('held across restart'))).toHaveLength(1);
    expect(restored.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
  });

  it('keeps durable recovery when unloaded immediately after summary commit, before input resumption', async () => {
    const env = await setup();
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary unavailable' }),
    ]);
    await env.recovery.prompt('original before resume');
    env.faux.setResponses([fauxAssistantMessage('committed summary')]);
    const unsubscribe = env.session.subscribe((event) => {
      if (event.type === 'compaction_end' && event.result && !event.aborted) env.recovery.dispose();
    });
    await env.recovery.retryCompaction();
    unsubscribe();
    expect(env.manager.getEntries().filter((entry) => entry.type === 'compaction')).toHaveLength(1);
    const restored = await env.reopen();
    expect(restored.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 0 });
    const compact = vi.spyOn(restored.session, 'compact');
    env.faux.setResponses([fauxAssistantMessage('resumed after reload')]);
    await restored.recovery.retryCompaction();
    expect(compact).not.toHaveBeenCalled();
    expect(
      restored.manager.getEntries().filter((entry) => entry.type === 'compaction')
    ).toHaveLength(1);
    const history = projectHistory(await readFile(join(env.dir, 'session.jsonl'), 'utf8'), 's1');
    expect(
      history.filter(
        (message) => message.role === 'user' && message.text === 'original before resume'
      )
    ).toHaveLength(1);
    expect(restored.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
  });

  it.each([false, true])(
    'persists the recovery gate through resumed provider work and reloads without duplicate users (held input: %s)',
    async (held) => {
      const env = await setup();
      env.faux.setResponses([
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary unavailable' }),
      ]);
      await env.recovery.prompt('original resumed input');
      if (held) await env.recovery.prompt('held resumed input');
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
      const committed = env.manager.getEntries().findLast((entry) => entry.type === 'compaction');
      expect(committed).toBeDefined();
      const checkpoint = env.manager
        .getEntries()
        .findLast(
          (entry) => entry.type === 'custom' && entry.customType === 'fynvra-context-recovery'
        );
      expect(checkpoint).toMatchObject({
        data: { blocked: true, resume: true, resumeCompactionId: committed?.id, pending: [] },
      });
      const reopening = env.reopen();
      late.resolve(fauxAssistantMessage('late interrupted answer'));
      await attempt;
      const restored = await reopening;
      expect(restored.latest()).toMatchObject({ recoveryRequired: true, pendingPromptCount: 0 });
      const compact = vi.spyOn(restored.session, 'compact');
      env.faux.setResponses([fauxAssistantMessage('finished after reload')]);
      await restored.recovery.retryCompaction();
      expect(compact).not.toHaveBeenCalled();
      expect(
        restored.manager.getEntries().filter((entry) => entry.type === 'compaction')
      ).toHaveLength(1);
      const history = projectHistory(await readFile(join(env.dir, 'session.jsonl'), 'utf8'), 's1');
      expect(
        history.filter(
          (message) => message.role === 'user' && message.text === 'original resumed input'
        )
      ).toHaveLength(1);
      expect(
        history.filter(
          (message) => message.role === 'user' && message.text === 'held resumed input'
        )
      ).toHaveLength(held ? 1 : 0);
      expect(restored.latest()).toMatchObject({ recoveryRequired: false, pendingPromptCount: 0 });
      expect(
        restored.manager
          .getEntries()
          .findLast(
            (entry) => entry.type === 'custom' && entry.customType === 'fynvra-context-recovery'
          )
      ).toMatchObject({ data: { blocked: false, resume: false, pending: [] } });
    }
  );

  it('Stop after compaction keeps the interrupted resumption available for a later explicit retry', async () => {
    const env = await setup();
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary unavailable' }),
    ]);
    await env.recovery.prompt('stopped resumed input');
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
      history.filter(
        (message) => message.role === 'user' && message.text === 'stopped resumed input'
      )
    ).toHaveLength(1);
    expect(env.latest().recoveryRequired).toBe(false);
  });

  it('handles Stop in the public compact allocation gap without committing or reviving the turn', async () => {
    const env = await setup();
    env.faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary unavailable' }),
    ]);
    await env.recovery.prompt('pending');
    env.faux.setResponses([fauxAssistantMessage('must not commit')]);
    const attempt = env.recovery.retryCompaction().catch(() => undefined);
    const stop = env.recovery.abort();
    await Promise.all([attempt, stop]);
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    expect(env.latest()).toMatchObject({
      recoveryRequired: true,
      compaction: { phase: 'cancelled', cancelSource: 'user' },
    });
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
    expect(env.manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    expect(env.events.slice(eventCount).some((e) => e.type === 'context_runtime')).toBe(false);
  });

  it('reports configured policy separately from Magic runtime fallback', async () => {
    const env = await setup(false, 0, 'magic-context');
    expect(env.latest()).toMatchObject({
      configuredStrategy: 'magic-context',
      effectiveStrategy: 'magic-context',
    });
    expect(env.latest().context.compactionThresholdTokens).toBeUndefined();
    env.recovery.fallback();
    expect(env.latest()).toMatchObject({
      configuredStrategy: 'magic-context',
      effectiveStrategy: 'native',
      compactionTimeoutMs: 30_000,
    });
  });

  it('preserves short turns, actual context window, and Magic fallback snapshots', async () => {
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
