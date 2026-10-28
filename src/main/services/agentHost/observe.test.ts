import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalGate } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole, type Role } from '@fynvra/core';
import type { ApprovalRequest, SessionEventEnvelope } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenSession } from '../../../agent/supervisor';
import { createModelResolver } from '../providers/resolveModel';
import { createSessionStore } from '../sessions/sessionStore';
import { createAgentHost } from './agentHost';
import { InMemoryWorker, ScriptedSession } from './testing';

// 桌面通知经 observe 旁路拿到与 Renderer 相同的会话事件，旧审批不再分发。

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const careful: Role = {
  id: 'careful',
  name: 'Careful',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'supervised',
};

function setup(openSession: OpenSession) {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-observe-'));
  dirs.push(dir);
  const broadcasts: unknown[][] = [];
  const logs: string[] = [];
  const workspace = {
    id: 'ws-1',
    name: 'demo',
    repoPath: join(dir, 'repo'),
    defaultBranch: 'main',
    vcs: 'git' as const,
  };
  const host = createAgentHost({
    fork: () => new InMemoryWorker(openSession),
    agentDir: join(dir, 'agent'),
    store: createSessionStore({ filePath: join(dir, 'sessions.json') }),
    workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
    roles: {
      get: async (id) => getBuiltinRole(id) ?? (id === careful.id ? careful : undefined),
      list: async () => [...BUILTIN_ROLES, careful],
    },
    models: createModelResolver({
      list: async () => [
        {
          id: 'anthropic',
          name: 'Anthropic',
          api: 'anthropic-messages',
          enabled: true,
          models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
          apiKey: 'sk-test',
        },
      ],
    }),
    broadcast: (...args) => broadcasts.push(args),
    log: (_level, message) => logs.push(message),
  });
  host.start();
  const pushed = <T>(channel: string) =>
    broadcasts.filter(([name]) => name === channel).map(([, payload]) => payload as T);
  return { host, pushed, logs };
}

async function started(env: ReturnType<typeof setup>, roleId: string, text: string) {
  const created = await env.host.create({ workspaceId: 'ws-1', roleId });
  if (!created.ok) throw new Error(created.error);
  expect(await env.host.prompt(created.session.id, text)).toEqual({ ok: true });
  return created.session.id;
}

const answering: OpenSession = async () =>
  new ScriptedSession(async (_text, emit) => {
    emit({ type: 'text_delta', delta: 'Done.' });
    emit({ type: 'message_end', role: 'assistant', text: 'Done.' });
  });

describe('agent host observers', () => {
  it('see every session event the renderer gets, in order and with the same seq', async () => {
    const env = setup(answering);
    const seen: SessionEventEnvelope[] = [];
    env.host.observe({ event: (envelope) => seen.push(envelope) });

    const sessionId = await started(env, 'worker', 'Fix the login page');
    await vi.waitFor(() => expect(seen.at(-1)?.event.type).toBe('agent_settled'));

    expect(seen).toEqual(env.pushed<SessionEventEnvelope>(IPC_CHANNELS.SESSIONS_EVENT));
    expect(seen.map(({ event }) => event.type)).toEqual([
      'message_end',
      'text_delta',
      'message_end',
      'agent_settled',
    ]);
    expect(seen.every((envelope) => envelope.sessionId === sessionId)).toBe(true);
  });

  it('look sessions up by id: the IPC view, or undefined once removed', async () => {
    const env = setup(answering);
    const sessionId = await started(env, 'worker', 'Fix the login page');

    expect(env.host.get(sessionId)).toEqual(env.host.list('ws-1')[0]);
    expect(env.host.get(sessionId)).toMatchObject({
      id: sessionId,
      workspaceId: 'ws-1',
      title: 'Fix the login page',
    });
    await env.host.remove(sessionId);
    expect(env.host.get(sessionId)).toBeUndefined();
    expect(env.host.get('no-such-session')).toBeUndefined();
  });

  it('sees sanitized operation notices with the renderer seq and never pushes an approval', async () => {
    const asking: OpenSession = async ({ spec, approval }) => {
      if (!approval) throw new Error('no approval channel');
      const gate = createApprovalGate({ mode: spec.role.approvalMode, ...approval });
      return new ScriptedSession(async (_text, emit) => {
        const args = { command: 'git push' };
        emit({ type: 'tool_start', toolCallId: 'call-1', toolName: 'bash', args });
        await gate.check({ toolCallId: 'call-1', toolName: 'bash', input: args });
      });
    };
    const env = setup(asking);
    const approvals: ApprovalRequest[] = [];
    const seen: SessionEventEnvelope[] = [];
    env.host.observe({
      approval: (request) => approvals.push(request),
      event: (event) => seen.push(event),
    });

    const sessionId = await started(env, 'careful', 'Push it');
    await vi.waitFor(() => expect(seen.at(-1)?.event.type).toBe('agent_settled'));

    expect(approvals).toEqual([]);
    expect(env.pushed<ApprovalRequest>(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)).toEqual([]);
    expect(seen).toEqual(env.pushed<SessionEventEnvelope>(IPC_CHANNELS.SESSIONS_EVENT));
    expect(seen.filter(({ event }) => event.type === 'tool_notice')).toEqual([
      {
        sessionId,
        event: {
          type: 'tool_notice',
          toolCallId: 'call-1',
          toolName: 'bash',
          kind: 'command',
          seq: 3,
        },
      },
    ]);
    expect(
      await env.host.respondApproval({ sessionId, requestId: 'old', decision: 'deny' })
    ).toMatchObject({ ok: false });
  });

  it('stop after unsubscribing; a throwing observer is logged and does not block the others', async () => {
    const env = setup(answering);
    const kept: string[] = [];
    const dropped: string[] = [];
    env.host.observe({
      event: () => {
        throw new Error('boom');
      },
    });
    env.host.observe({ event: ({ event }) => kept.push(event.type) });
    const unsubscribe = env.host.observe({ event: ({ event }) => dropped.push(event.type) });
    unsubscribe();

    await started(env, 'worker', 'Fix the login page');
    await vi.waitFor(() => expect(kept.at(-1)).toBe('agent_settled'));

    expect(dropped).toEqual([]);
    expect(env.pushed(IPC_CHANNELS.SESSIONS_EVENT)).toHaveLength(kept.length);
    expect(env.logs.filter((message) => message.includes('boom'))).toHaveLength(kept.length);
  });
});
