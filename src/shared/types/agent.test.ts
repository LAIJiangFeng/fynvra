import type { FynvraSessionEvent } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  type AgentApprovalRequest,
  type AgentCommand,
  type AgentWorkerEvent,
  parseAgentCommand,
  parseAgentWorkerEvent,
  type SpawnSessionSpec,
} from './agent';

const identity = { sessionId: 'session-1', generation: 2 };

const approvalRequest: AgentApprovalRequest = {
  requestId: 'req-1',
  toolCallId: 'call-1',
  toolName: 'bash',
  kind: 'command',
  title: 'bash',
  detail: 'pnpm test',
  expiresAt: 1_700_000_600_000,
};

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

const screenshot = { data: 'iVBORw0KGgo=', mimeType: 'image/png' as const };

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
    {
      type: 'spawn-session',
      identity,
      spec: { ...spec, shellPath: 'D:\\Software\\Git\\bin\\bash.exe' },
    },
    { type: 'spawn-session', identity, spec: { ...spec, inPlace: true } },
    { type: 'prompt', identity, text: 'Fix the build' },
    { type: 'prompt', identity, text: 'What is wrong here?', images: [screenshot] },
    // 只有图片：文本可以是空串
    {
      type: 'prompt',
      identity,
      text: '',
      images: [screenshot, { ...screenshot, mimeType: 'image/webp' }],
    },
    { type: 'steer', identity, text: 'Also update the docs' },
    { type: 'abort', identity },
    { type: 'dispose-session', identity },
    { type: 'respond-approval', identity, requestId: 'req-1', decision: 'allowSession' },
    { type: 'host-result', identity, callId: '7', result: { ok: true, task: { id: 'task_1' } } },
    { type: 'host-result', identity, callId: '8', result: { ok: false, error: 'not wired' } },
    { type: 'shutdown' },
    {
      type: 'spawn-session',
      identity,
      spec: { ...spec, model: { ...spec.model, reasoning: true } },
    },
    { type: 'set-model', identity, model: spec.model },
    { type: 'set-model', identity, model: { ...spec.model, thinking: 'max' } },
    {
      type: 'set-model',
      identity,
      model: {
        providerId: 'fynvra-1',
        api: 'openai-completions',
        modelId: 'qwen3',
        reasoning: false,
      },
    },
    {
      type: 'describe-models',
      requestId: 'describe-1',
      models: [
        { api: 'anthropic-messages', modelId: 'claude-opus-5-5' },
        { api: 'openai-completions', modelId: 'qwen3-coder', reasoning: true },
      ],
    },
    { type: 'describe-models', requestId: 'describe-2', models: [] },
    { type: 'set-approval-mode', identity, mode: 'supervised' },
    { type: 'set-approval-mode', identity, mode: 'auto-edits' },
    { type: 'set-approval-mode', identity, mode: 'full' },
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
    // describe-models 是进程级命令：identity 与查询项里的多余字段都丢掉
    expect(
      parseAgentCommand({
        type: 'describe-models',
        identity,
        requestId: 'describe-1',
        models: [{ api: 'anthropic-messages', modelId: 'claude-opus-5-5', apiKey: 'sk-x' }],
      })
    ).toEqual({
      type: 'describe-models',
      requestId: 'describe-1',
      models: [{ api: 'anthropic-messages', modelId: 'claude-opus-5-5' }],
    });
    expect(
      parseAgentCommand({ type: 'set-approval-mode', identity, mode: 'full', role: 'orchestrator' })
    ).toEqual({ type: 'set-approval-mode', identity, mode: 'full' });
    // steer 不带图片：多余的 images 与其他未知字段一样丢掉
    expect(
      parseAgentCommand({ type: 'steer', identity, text: 'look', images: [screenshot] })
    ).toEqual({ type: 'steer', identity, text: 'look' });
  });

  it('keeps inPlace only when it is true (false is the default)', () => {
    const parsed = parseAgentCommand(withSpec({ inPlace: false }));
    expect(parsed?.type === 'spawn-session' && parsed.spec).not.toHaveProperty('inPlace');
  });

  it('normalizes the none alias of off in a model spec', () => {
    const parsed = parseAgentCommand(withModel({ thinking: 'none' }));
    expect(parsed?.type === 'spawn-session' && parsed.spec.model.thinking).toBe('off');
    expect(
      parseAgentCommand({ type: 'set-model', identity, model: { ...spec.model, thinking: 'none' } })
    ).toEqual({ type: 'set-model', identity, model: { ...spec.model, thinking: 'off' } });
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
    [
      'an empty prompt with an empty image list',
      { type: 'prompt', identity, text: '', images: [] },
    ],
    ['a prompt with images but no text', { type: 'prompt', identity, images: [screenshot] }],
    ['a prompt with a null image list', { type: 'prompt', identity, text: 'hi', images: null }],
    [
      'a prompt whose images are not a list',
      { type: 'prompt', identity, text: 'hi', images: screenshot },
    ],
    [
      'a prompt with an image in a format outside the whitelist',
      { type: 'prompt', identity, text: 'hi', images: [{ ...screenshot, mimeType: 'image/bmp' }] },
    ],
    [
      'a prompt with an image that is not base64',
      { type: 'prompt', identity, text: 'hi', images: [{ ...screenshot, data: 'not base64!' }] },
    ],
    [
      'a prompt with an image that has extra fields',
      { type: 'prompt', identity, text: 'hi', images: [{ ...screenshot, name: 'a.png' }] },
    ],
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
    ['an empty shell path', withSpec({ shellPath: '' })],
    ['a shell path that is not a string', withSpec({ shellPath: ['bash.exe'] })],
    ['a non-boolean inPlace flag', withSpec({ inPlace: 'none' })],
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
    ['a string reasoning flag', withModel({ reasoning: 'yes' })],
    ['a set-model without identity', { type: 'set-model', model: spec.model }],
    ['a set-model without model', { type: 'set-model', identity }],
    [
      'a set-model with an empty model id',
      { type: 'set-model', identity, model: { ...spec.model, modelId: '' } },
    ],
    [
      'a set-model with an unknown thinking level',
      { type: 'set-model', identity, model: { ...spec.model, thinking: 'ultra' } },
    ],
    ['a describe-models without request id', { type: 'describe-models', models: [] }],
    [
      'a describe-models whose models are not a list',
      { type: 'describe-models', requestId: 'd', models: { api: 'a', modelId: 'm' } },
    ],
    [
      'a describe-models query without model id',
      { type: 'describe-models', requestId: 'd', models: [{ api: 'anthropic-messages' }] },
    ],
    [
      'a describe-models query with a numeric reasoning flag',
      {
        type: 'describe-models',
        requestId: 'd',
        models: [{ api: 'a', modelId: 'm', reasoning: 1 }],
      },
    ],
    ['a set-approval-mode without identity', { type: 'set-approval-mode', mode: 'full' }],
    [
      'a set-approval-mode with a stale-looking identity',
      { type: 'set-approval-mode', identity: { sessionId: 's', generation: 0 }, mode: 'full' },
    ],
    ['a set-approval-mode without mode', { type: 'set-approval-mode', identity }],
    [
      'a set-approval-mode with an unknown mode',
      { type: 'set-approval-mode', identity, mode: 'yolo' },
    ],
    [
      'a set-approval-mode with a differently cased mode',
      { type: 'set-approval-mode', identity, mode: 'Full' },
    ],
    ['a set-approval-mode with a null mode', { type: 'set-approval-mode', identity, mode: null }],
    [
      'a set-approval-mode with a mode list',
      { type: 'set-approval-mode', identity, mode: ['full'] },
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
    { type: 'approval-request', identity, request: approvalRequest },
    {
      type: 'approval-request',
      identity,
      request: { ...approvalRequest, protectedAction: 'git push', detail: '' },
    },
    {
      type: 'models-described',
      requestId: 'describe-1',
      result: {
        ok: true,
        models: [
          { thinkingLevels: ['low', 'medium', 'high', 'xhigh'], defaultThinking: 'medium' },
          { thinkingLevels: [] },
        ],
      },
    },
    {
      type: 'models-described',
      requestId: 'describe-3',
      result: {
        ok: true,
        models: [
          {
            thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultThinking: 'medium',
            source: 'catalog',
          },
          {
            thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultThinking: 'medium',
            source: 'inferred:gpt-6.1-sol',
          },
          { thinkingLevels: [], source: 'fallback' },
        ],
      },
    },
    {
      type: 'models-described',
      requestId: 'describe-2',
      result: { ok: false, error: 'the model catalog is not ready' },
    },
  ];

  it.each(valid)('accepts a well-formed $type event', (event) => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('drops unknown fields of an approval request', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'approval-request',
        identity,
        request: { ...approvalRequest, args: { command: 'echo hi' }, extra: 1 },
      })
    ).toEqual({ type: 'approval-request', identity, request: approvalRequest });
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
  const described = (result: Record<string, unknown>, requestId = 'describe-1') => ({
    type: 'models-described',
    requestId,
    result,
  });

  it('drops unknown fields of a models-described answer', () => {
    expect(
      parseAgentWorkerEvent({
        ...described({
          ok: true,
          models: [{ thinkingLevels: ['high'], defaultThinking: 'high', provider: 'openai' }],
          extra: 1,
        }),
        identity,
      })
    ).toEqual(
      described({ ok: true, models: [{ thinkingLevels: ['high'], defaultThinking: 'high' }] })
    );
  });

  it('normalizes the none alias of off in a capability', () => {
    expect(
      parseAgentWorkerEvent(
        described({
          ok: true,
          models: [{ thinkingLevels: ['none', 'low', 'medium'], defaultThinking: 'none' }],
        })
      )
    ).toEqual(
      described({
        ok: true,
        models: [{ thinkingLevels: ['off', 'low', 'medium'], defaultThinking: 'off' }],
      })
    );
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
    [
      'an approval request without identity',
      { type: 'approval-request', request: approvalRequest },
    ],
    ['an approval request without request', { type: 'approval-request', identity }],
    ['a models-described without request id', described({ ok: true, models: [] }, '')],
    ['a models-described without result', { type: 'models-described', requestId: 'd' }],
    ['a models-described result with a string ok', described({ ok: 'true', models: [] })],
    ['a successful models-described without models', described({ ok: true })],
    ['a failed models-described without error', described({ ok: false })],
    [
      'a capability whose levels are not a list',
      described({ ok: true, models: [{ thinkingLevels: 'low' }] }),
    ],
    [
      'a capability with a level fynvra does not know',
      described({ ok: true, models: [{ thinkingLevels: ['high', 'ultra'] }] }),
    ],
    [
      'a capability that repeats a level',
      described({ ok: true, models: [{ thinkingLevels: ['low', 'low'] }] }),
    ],
    [
      'a capability that repeats off through its none alias',
      described({ ok: true, models: [{ thinkingLevels: ['none', 'off'] }] }),
    ],
    ...['guess', 'inferred:', 'Catalog', 1].map((source): [string, unknown] => [
      `a capability with the source ${JSON.stringify(source)}`,
      described({ ok: true, models: [{ thinkingLevels: ['high'], source }] }),
    ]),
    [
      'a default level the model does not offer',
      described({ ok: true, models: [{ thinkingLevels: ['low'], defaultThinking: 'medium' }] }),
    ],
    ...(
      [
        ['an empty request id', { requestId: '' }],
        ['a numeric tool call id', { toolCallId: 1 }],
        ['an empty tool name', { toolName: '' }],
        ['an unknown kind', { kind: 'network' }],
        ['an inherited kind', { kind: 'toString' }],
        ['a missing title', { title: undefined }],
        ['a null detail', { detail: null }],
        ['a numeric protected action', { protectedAction: 1 }],
        ['a string expiry', { expiresAt: '1700000000000' }],
        ['a non-positive expiry', { expiresAt: 0 }],
        ['an infinite expiry', { expiresAt: Number.POSITIVE_INFINITY }],
      ] as const
    ).map(([label, patch]): [string, unknown] => [
      `an approval request with ${label}`,
      { type: 'approval-request', identity, request: { ...approvalRequest, ...patch } },
    ]),
  ])('rejects %s', (_label, raw) => {
    expect(parseAgentWorkerEvent(raw)).toBeNull();
  });
});
