import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { Role } from '@fynvra/core';
import { type AgentCommand, parseAgentCommand } from '@shared/types/agent';
import type { SessionEventEnvelope } from '@shared/types/chat';
import { afterEach, expect, it, vi } from 'vitest';
import { createPiSessionFactory } from '../../../agent/piSession';
import { projectHistory, sessionFilePath } from '../sessions/history';
import { createSessionStore } from '../sessions/sessionStore';
import { createAgentHost } from './agentHost';
import { InMemoryWorker } from './testing';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: { seed?: boolean; beforeOpen?: () => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fynvra-reload-compaction-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({
    provider: 'recovery-test',
    models: [{ id: 'model', contextWindow: 100_000, maxTokens: 1000 }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const agentDir = join(dir, 'agent');
  const open = createPiSessionFactory({
    agentDir,
    resolveModel: async () => ({ runtime, model: faux.getModel() }),
  });
  const workers: InMemoryWorker[] = [];
  const commands: AgentCommand[] = [];
  const role: Role = {
    id: 'worker',
    name: 'Worker',
    tools: 'readonly',
    approvalMode: 'full',
    skillIds: [],
    mcpServerIds: [],
  };
  const createHost = () =>
    createAgentHost({
      agentDir,
      resolveCompactionStrategy: () => 'native',
      store: createSessionStore({ filePath: join(dir, 'sessions.json') }),
      workspaces: {
        get: () => ({ id: 'ws1', name: 'repo', repoPath: dir, vcs: 'git', defaultBranch: 'main' }),
      },
      roles: { get: async () => role, list: async () => [role] },
      models: {
        resolve: async () => ({
          ok: true,
          model: { providerId: 'recovery-test', api: faux.api, modelId: 'model' },
          ref: { providerId: 'recovery-test', modelId: 'model' },
        }),
      },
      fork: () => {
        class Worker extends InMemoryWorker {
          override postMessage(raw: unknown) {
            const command = parseAgentCommand(raw);
            if (command) commands.push(command);
            super.postMessage(raw);
          }
        }
        const worker = new Worker(async (input) => {
          await options.beforeOpen?.();
          return open(input);
        });
        workers.push(worker);
        return worker;
      },
      broadcast: () => {},
      log: () => {},
      workerOptions: { maxRestarts: 0 },
    });
  let host = createHost();
  cleanup.push(async () => {
    await host.shutdown(1000);
    await Promise.all(workers.map((worker) => worker.supervisor.shutdown()));
  });
  const events: SessionEventEnvelope[] = [];
  host.observe({ event: (event) => events.push(event) });
  host.start();
  const created = await host.create({ workspaceId: 'ws1', roleId: 'worker' });
  if (!created.ok) throw new Error(created.error);
  const id = created.session.id;
  const file = sessionFilePath(agentDir, id);
  if (options.seed !== false) {
    const manager = SessionManager.open(file, join(agentDir, 'sessions'), dir);
    for (let i = 0; i < 6; i++) {
      manager.appendMessage({
        role: 'user',
        content: `old-${i} ${'history '.repeat(4000)}`,
        timestamp: i,
      });
      const answer = fauxAssistantMessage(`old answer ${i}`);
      answer.usage = { ...answer.usage, input: 90000, output: 20, totalTokens: 90020 };
      manager.appendMessage(answer);
    }
    manager.appendMessage({ role: 'user', content: 'already written input', timestamp: 7 });
    manager.appendCustomEntry('fynvra-context-recovery', {
      blocked: true,
      resume: true,
      pending: [{ text: 'held original input' }],
    });
  }
  const recovered = () =>
    vi.waitFor(() => {
      expect(host.get(id)?.status).toBe('idle');
      expect(host.get(id)?.contextRuntime).toMatchObject({
        recoveryRequired: false,
        pendingPromptCount: 0,
      });
    });
  const users = async () =>
    projectHistory(await readFile(file, 'utf8'), id)
      .filter((message) => message.role === 'user')
      .map((message) => message.text);
  const validResponses = () =>
    faux.setResponses(
      Array.from({ length: 5 }, () => fauxAssistantMessage('valid summary or answer'))
    );
  const restartMain = async () => {
    await host.shutdown(1000);
    host = createHost();
    host.observe({ event: (event) => events.push(event) });
    host.start();
    return host;
  };
  return {
    get host() {
      return host;
    },
    id,
    file,
    faux,
    workers,
    commands,
    events,
    recovered,
    users,
    validResponses,
    restartMain,
  };
}

it('discovers a persistent checkpoint after a complete Main restart and recovers by id without any live snapshot', async () => {
  const env = await setup();
  await env.restartMain();
  expect(env.host.get(env.id)?.contextRuntime).toBeUndefined();
  expect(env.host.list('ws1')[0]?.contextRuntime).toBeUndefined();
  const original = await readFile(env.file, 'utf8');
  const history = await env.host.history(env.id);
  if (!history.ok) throw new Error(history.error);
  expect(history.contextRecovery).toEqual({ recoveryRequired: true });
  expect(history.contextRuntimeSeq).toBe(0);
  expect(history.contextRuntime).toBeUndefined();
  expect(history.messages.some((message) => message.text === 'held original input')).toBe(false);
  expect(await readFile(env.file, 'utf8')).toBe(original);
  expect(env.faux.state.callCount).toBe(0);
  expect(env.commands.some((command) => command.type === 'spawn-session')).toBe(false);
  env.validResponses();
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await env.recovered();
  const users = await env.users();
  expect(users.filter((text) => text === 'already written input')).toHaveLength(1);
  expect(users.filter((text) => text === 'held original input')).toHaveLength(1);
  expect(env.commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  const calls = env.faux.state.callCount;
  await env.restartMain();
  expect(await env.host.history(env.id)).toMatchObject({
    ok: true,
    contextRecovery: { recoveryRequired: false },
    contextRuntimeSeq: 0,
  });
  expect(env.host.get(env.id)?.contextRuntime).toBeUndefined();
  expect(env.faux.state.callCount).toBe(calls);
});

it('reloads the original checkpoint after worker exit using only explicit recovery, without resending either input', async () => {
  const env = await setup();
  env.faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary invalid' }),
  ]);
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await vi.waitFor(() => expect(env.host.get(env.id)?.status).toBe('error'));
  expect(env.host.get(env.id)?.contextRuntime?.recoveryRequired).toBe(true);
  const first = env.workers[0];
  if (!first) throw new Error('missing worker');
  await first.supervisor.shutdown();
  first.kill();
  expect(env.host.get(env.id)?.contextRuntime).toBeUndefined();
  const priorEventCount = env.events.length;
  const priorSeq = env.events.at(-1)?.event.seq ?? 0;
  env.validResponses();
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await env.recovered();
  expect(env.workers).toHaveLength(2);
  const spawns = env.commands.filter((command) => command.type === 'spawn-session');
  expect(spawns.map((command) => command.identity)).toEqual([
    { sessionId: env.id, generation: 1 },
    { sessionId: env.id, generation: 2 },
  ]);
  const operations = env.events.flatMap(({ event }) =>
    event.type === 'compaction' ? [event.state.operationId] : []
  );
  expect(new Set(operations).size).toBe(2);
  const seqs = env.events.map(({ event }) => event.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(env.events[priorEventCount]?.event.seq).toBeGreaterThan(priorSeq);
  expect(env.host.get(env.id)?.contextRuntimeSeq).toBe(
    env.events.findLast(({ event }) => event.type === 'context_runtime')?.event.seq
  );
  expect(env.commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  const users = await env.users();
  expect(users.filter((text) => text === 'already written input')).toHaveLength(1);
  expect(users.filter((text) => text === 'held original input')).toHaveLength(1);
});

it('does not compact an unloaded ordinary idle session without a recovery checkpoint', async () => {
  const env = await setup({ seed: false });
  expect(env.host.get(env.id)?.contextRuntime).toBeUndefined();
  expect(await env.host.history(env.id)).toEqual({ ok: true, messages: [], contextRuntimeSeq: 0 });
  expect(env.faux.state.callCount).toBe(0);
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await vi.waitFor(() => expect(env.host.get(env.id)?.status).toBe('error'));
  expect(env.host.get(env.id)?.contextRuntime).toMatchObject({
    effectiveStrategy: 'native',
    recoveryRequired: false,
  });
  expect(env.faux.state.callCount).toBe(0);
  expect(env.host.get(env.id)?.contextRuntime?.compaction).toBeUndefined();
});

it('Stop during worker opening cancels the queued recovery and does not revive when loading completes', async () => {
  const opening = Promise.withResolvers<void>();
  const env = await setup({ beforeOpen: () => opening.promise });
  env.validResponses();
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await vi.waitFor(() =>
    expect(env.commands.some((command) => command.type === 'retry-compaction')).toBe(true)
  );
  expect(await env.host.abort(env.id)).toEqual({ ok: true });
  opening.resolve();
  await vi.waitFor(() => expect(env.host.get(env.id)?.status).toBe('idle'));
  expect(env.faux.state.callCount).toBe(0);
  expect(env.host.get(env.id)?.contextRuntime?.recoveryRequired).toBe(true);
  expect((await env.users()).filter((text) => text === 'held original input')).toHaveLength(0);
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await env.recovered();
  expect((await env.users()).filter((text) => text === 'held original input')).toHaveLength(1);
});

it('leaves checkpoint and history untouched on loading failure, and a later id-only retry recovers them', async () => {
  let rejectOpen = true;
  const env = await setup({
    beforeOpen: async () => {
      if (rejectOpen) throw new Error('offline startup failure');
    },
  });
  const original = await readFile(env.file, 'utf8');
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await vi.waitFor(() => expect(env.host.get(env.id)?.status).toBe('error'));
  expect(env.host.get(env.id)?.contextRuntime).toBeUndefined();
  expect(await readFile(env.file, 'utf8')).toBe(original);
  expect(env.faux.state.callCount).toBe(0);
  rejectOpen = false;
  env.validResponses();
  expect(await env.host.retryCompaction(env.id)).toEqual({ ok: true });
  await env.recovered();
  expect((await env.users()).filter((text) => text === 'held original input')).toHaveLength(1);
});
