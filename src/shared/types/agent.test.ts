import type { FynvraSessionEvent } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  type AgentCommand,
  type AgentWorkerEvent,
  parseAgentCommand,
  parseAgentWorkerEvent,
  type SpawnSessionSpec,
} from './agent';

const identity = { sessionId: 'session-1', generation: 2 };

const spec: SpawnSessionSpec = {
  role: {
    id: 'worker',
    name: 'Worker',
    skillIds: [],
    mcpServerIds: ['docs'],
    tools: 'all',
    approvalMode: 'auto-edits',
  },
  cwd: 'C:\\repos\\demo',
  sessionFile: 'C:\\data\\agent\\sessions\\session-1.jsonl',
  model: {
    providerId: 'anthropic',
    api: 'anthropic-messages',
    apiKey: 'sk-test',
    modelId: 'claude-sonnet-5-5',
    thinking: 'high',
  },
  skills: ['C:\\skills\\release-notes'],
  mcpServers: [
    { name: 'docs', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
    { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '.' } },
  ],
  worker: true,
  roles: [
    { id: 'worker', name: 'Worker' },
    { id: 'tester', name: 'Tester', description: 'Writes tests' },
  ],
};

const withSpec = (patch: Record<string, unknown>) => ({
  type: 'spawn-session',
  identity,
  spec: { ...spec, ...patch },
});
const withModel = (patch: Record<string, unknown>) =>
  withSpec({ model: { ...spec.model, ...patch } });

describe('parseAgentCommand', () => {
  const valid: AgentCommand[] = [
    { type: 'spawn-session', identity, spec },
    {
      type: 'spawn-session',
      identity: { sessionId: 's', generation: 1 },
      spec: {
        ...spec,
        model: { providerId: 'p', api: 'a', modelId: 'm' },
        mcpServers: [],
        skills: [],
        roles: [],
      },
    },
    { type: 'prompt', identity, text: 'Fix the build' },
    { type: 'steer', identity, text: 'Also update the docs' },
    { type: 'abort', identity },
    { type: 'dispose-session', identity },
    { type: 'respond-approval', identity, requestId: 'req-1', decision: 'allowSession' },
    { type: 'host-result', identity, callId: '7', result: { ok: true, task: { id: 'task_1' } } },
    { type: 'host-result', identity, callId: '8', result: { ok: false, error: 'not wired' } },
    { type: 'shutdown' },
  ];

  it.each(valid)('accepts a well-formed $type command', (command) => {
    expect(parseAgentCommand(command)).toEqual(command);
  });

  it('drops unknown fields instead of passing them through', () => {
    expect(
      parseAgentCommand({
        type: 'prompt',
        identity: { ...identity, path: 'x' },
        text: 'hi',
        cwd: '/',
      })
    ).toEqual({ type: 'prompt', identity, text: 'hi' });
    expect(parseAgentCommand({ type: 'shutdown', identity })).toEqual({ type: 'shutdown' });
    const parsed = parseAgentCommand(
      withSpec({ extra: 1, roles: [{ id: 'worker', name: 'Worker', builtin: true }] })
    );
    expect(parsed?.type === 'spawn-session' && parsed.spec).not.toHaveProperty('extra');
    expect(parsed?.type === 'spawn-session' && parsed.spec.roles).toEqual([
      { id: 'worker', name: 'Worker' },
    ]);
  });

  it.each([
    ['null', null],
    ['a string', 'prompt'],
    ['an array', [{ type: 'abort', identity }]],
    ['an unknown type', { type: 'exec', identity, command: 'rm -rf /' }],
    ['a missing identity', { type: 'prompt', text: 'hi' }],
    ['an empty session id', { type: 'abort', identity: { sessionId: '', generation: 1 } }],
    ['generation 0', { type: 'abort', identity: { sessionId: 's', generation: 0 } }],
    ['a negative generation', { type: 'abort', identity: { sessionId: 's', generation: -1 } }],
    ['a fractional generation', { type: 'abort', identity: { sessionId: 's', generation: 1.5 } }],
    ['a string generation', { type: 'abort', identity: { sessionId: 's', generation: '1' } }],
    ['an empty prompt', { type: 'prompt', identity, text: '' }],
    ['a non-string steer', { type: 'steer', identity, text: 42 }],
    ['a role that fails parseRole', withSpec({ role: { id: 'worker', name: 'Worker' } })],
    ['an empty cwd', withSpec({ cwd: '' })],
    ['a missing session file', withSpec({ sessionFile: undefined })],
    ['an empty model id', withModel({ modelId: '' })],
    ['an empty base URL', withModel({ baseUrl: '' })],
    ['a null api key', withModel({ apiKey: null })],
    ['an unknown thinking level', withModel({ thinking: 'turbo' })],
    ['skills that are not strings', withSpec({ skills: ['ok', 3] })],
    ['an MCP server without command or url', withSpec({ mcpServers: [{ name: 'x' }] })],
    [
      'an MCP env with a non-string value',
      withSpec({ mcpServers: [{ name: 'x', command: 'c', env: { A: 1 } }] }),
    ],
    [
      'MCP args that are not a list',
      withSpec({ mcpServers: [{ name: 'x', command: 'c', args: '-y' }] }),
    ],
    ['a non-boolean worker flag', withSpec({ worker: 'yes' })],
    ['a role option without a name', withSpec({ roles: [{ id: 'worker' }] })],
    [
      'an unknown approval decision',
      { type: 'respond-approval', identity, requestId: 'r', decision: 'maybe' },
    ],
    [
      'an empty approval request id',
      { type: 'respond-approval', identity, requestId: '', decision: 'deny' },
    ],
    ['a host result without callId', { type: 'host-result', identity, result: { ok: true } }],
    [
      'a host result that is not an object',
      { type: 'host-result', identity, callId: '1', result: 'ok' },
    ],
    [
      'a host result with a string ok',
      { type: 'host-result', identity, callId: '1', result: { ok: 'true' } },
    ],
    [
      'a failed host result without error',
      { type: 'host-result', identity, callId: '1', result: { ok: false } },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parseAgentCommand(raw)).toBeNull();
  });
});

describe('parseAgentWorkerEvent', () => {
  const events: FynvraSessionEvent[] = [
    { type: 'text_delta', delta: 'Hel', seq: 1 },
    { type: 'thinking_delta', delta: 'hmm', seq: 2 },
    { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' }, seq: 3 },
    {
      type: 'tool_start',
      toolCallId: 'c2',
      toolName: 'read',
      args: null,
      parentToolCallId: 'c1',
      seq: 4,
    },
    {
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: false,
      output: 'a.ts',
      outputTruncated: false,
      durationMs: 12,
      seq: 5,
    },
    { type: 'message_end', role: 'user', text: 'hi', seq: 6 },
    {
      type: 'message_end',
      role: 'assistant',
      text: '',
      stopReason: 'error',
      errorMessage: '401',
      seq: 7,
    },
    { type: 'agent_settled', aborted: true, seq: 8 },
    {
      type: 'approval_request',
      requestId: 'r1',
      toolCallId: 'c3',
      toolName: 'bash',
      args: { command: 'rm x' },
      reason: 'supervised',
      seq: 9,
    },
    {
      type: 'usage',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: 0.001,
      seq: 10,
    },
    { type: 'error', source: 'host', message: 'worker crashed', seq: 11 },
  ];

  it.each(events)('accepts a session-event carrying $type', (event) => {
    const message = { type: 'session-event', identity, seq: event.seq, event };
    expect(parseAgentWorkerEvent(message)).toEqual(message);
  });

  const valid: AgentWorkerEvent[] = [
    { type: 'ready' },
    { type: 'log', level: 'warn', message: 'skill missing' },
    { type: 'session-status', identity, status: 'waiting-approval' },
    {
      type: 'host-invoke',
      identity,
      callId: '3',
      kind: 'orchestration',
      method: 'dispatchTask',
      input: { title: 'T', spec: 'S', roleId: 'worker', dependsOn: [] },
    },
    {
      type: 'host-invoke',
      identity,
      callId: '4',
      kind: 'worker',
      method: 'reportDone',
      input: undefined,
    },
    { type: 'host-cancel', identity, callId: '3' },
    { type: 'session-error', identity, error: 'no API key', fatal: true },
  ];

  it.each(valid)('accepts a well-formed $type event', (event) => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('drops unknown fields of the envelope and of the session event', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'session-event',
        identity,
        seq: 1,
        extra: true,
        event: { type: 'text_delta', delta: 'a', seq: 1, secret: 'x' },
      })
    ).toEqual({
      type: 'session-event',
      identity,
      seq: 1,
      event: { type: 'text_delta', delta: 'a', seq: 1 },
    });
  });

  const sessionEvent = (event: Record<string, unknown>, seq = 1) => ({
    type: 'session-event',
    identity,
    seq,
    event: { seq: 1, ...event },
  });

  it.each([
    ['null', null],
    ['an unknown type', { type: 'spawned', identity }],
    ['a log with an unknown level', { type: 'log', level: 'debug', message: 'x' }],
    ['a log without a message', { type: 'log', level: 'info' }],
    [
      'a session event without identity',
      { type: 'session-event', seq: 1, event: { type: 'text_delta', delta: 'a', seq: 1 } },
    ],
    [
      'an envelope seq that differs from the event seq',
      sessionEvent({ type: 'text_delta', delta: 'a' }, 2),
    ],
    [
      'seq 0',
      {
        type: 'session-event',
        identity,
        seq: 0,
        event: { type: 'text_delta', delta: 'a', seq: 0 },
      },
    ],
    ['an unknown event type', sessionEvent({ type: 'tool_progress' })],
    ['an inherited event type', sessionEvent({ type: 'toString' })],
    ['a text delta without delta', sessionEvent({ type: 'text_delta' })],
    [
      'a tool_end without outputTruncated',
      sessionEvent({
        type: 'tool_end',
        toolCallId: 'c',
        toolName: 'bash',
        isError: false,
        output: '',
      }),
    ],
    [
      'a tool_end with a null duration',
      sessionEvent({
        type: 'tool_end',
        toolCallId: 'c',
        toolName: 'bash',
        isError: false,
        output: '',
        outputTruncated: false,
        durationMs: null,
      }),
    ],
    [
      'a message_end from the system',
      sessionEvent({ type: 'message_end', role: 'system', text: '' }),
    ],
    [
      'usage with a string count',
      sessionEvent({
        type: 'usage',
        provider: 'p',
        model: 'm',
        input: '1',
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: 0,
      }),
    ],
    [
      'an error from an unknown source',
      sessionEvent({ type: 'error', source: 'network', message: 'x' }),
    ],
    [
      'an approval request without id',
      sessionEvent({
        type: 'approval_request',
        requestId: '',
        toolCallId: 'c',
        toolName: 'bash',
        args: {},
      }),
    ],
    ['an unknown session status', { type: 'session-status', identity, status: 'busy' }],
    [
      'a host invoke of an unknown kind',
      { type: 'host-invoke', identity, callId: '1', kind: 'shell', method: 'run', input: {} },
    ],
    [
      'a host invoke without method',
      { type: 'host-invoke', identity, callId: '1', kind: 'worker', method: '', input: {} },
    ],
    ['a host cancel without callId', { type: 'host-cancel', identity }],
    ['a session error without the fatal flag', { type: 'session-error', identity, error: 'x' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseAgentWorkerEvent(raw)).toBeNull();
  });
});
