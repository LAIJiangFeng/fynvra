import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiSessionFactory } from '../../../agent/piSession';
import { HISTORY_TOOL_OUTPUT_CHARS, projectHistory, readHistory, sessionFilePath } from './history';

// pi 1.4.0 jsonl 的条目形状（由真实会话写出的文件整理而来）
const header = {
  type: 'session',
  version: 3,
  id: 'pi-1',
  timestamp: '2026-10-24T08:00:00.000Z',
  cwd: '/repo',
};
let previous: string | null = null;
function entry(id: string, message: Record<string, unknown>, parentId = previous) {
  previous = id;
  return { type: 'message', id, parentId, timestamp: '2026-10-24T08:00:01.000Z', message };
}
function jsonl(...lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
const user = (text: string, timestamp = 1_000) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp,
});
const assistant = (content: unknown[], patch: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  provider: 'fynvra-x',
  model: 'claude-sonnet-5-5',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { total: 0.002 },
  },
  stopReason: 'stop',
  timestamp: 2_000,
  ...patch,
});
const toolResult = (toolCallId: string, text: string, patch: Record<string, unknown> = {}) => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'ls',
  content: [{ type: 'text', text }],
  isError: false,
  durationMs: 7,
  timestamp: 3_000,
  ...patch,
});

describe('projectHistory', () => {
  it('projects user, assistant and tool results along the current branch', () => {
    previous = null;
    const text = jsonl(
      header,
      {
        type: 'model_change',
        id: 'm0',
        parentId: null,
        timestamp: 't',
        provider: 'p',
        modelId: 'm',
      },
      entry('sys', { role: 'system', content: '', sections: {} }, 'm0'),
      entry('u1', user('What is here?')),
      entry(
        'a1',
        assistant(
          [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'Listing.' },
            { type: 'toolCall', id: 'call-1', name: 'ls', arguments: { path: '.' } },
          ],
          { stopReason: 'toolUse' }
        )
      ),
      entry('r1', toolResult('call-1', 'a.txt')),
      entry('a2', assistant([{ type: 'text', text: 'Found a.txt' }], { usage: undefined }))
    );

    expect(projectHistory(text, 'session-1')).toEqual([
      {
        id: 'u1',
        sessionId: 'session-1',
        role: 'user',
        text: 'What is here?',
        toolCalls: [],
        createdAt: 1_000,
        streaming: false,
      },
      {
        id: 'a1',
        sessionId: 'session-1',
        role: 'assistant',
        text: 'Listing.',
        thinking: 'let me look',
        toolCalls: [
          {
            id: 'call-1',
            name: 'ls',
            args: { path: '.' },
            status: 'done',
            output: 'a.txt',
            durationMs: 7,
          },
        ],
        createdAt: 2_000,
        streaming: false,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
      },
      {
        id: 'a2',
        sessionId: 'session-1',
        role: 'assistant',
        text: 'Found a.txt',
        toolCalls: [],
        createdAt: 2_000,
        streaming: false,
      },
    ]);
  });

  it('follows the branch that ends at the last entry, not every line of the file', () => {
    previous = null;
    const text = jsonl(
      header,
      entry('u1', user('first try')),
      entry('a1', assistant([{ type: 'text', text: 'abandoned answer' }])),
      // 回到 u1 之前重新提问：新分支从根开始
      entry('u2', user('second try', 5_000), null),
      entry('a2', assistant([{ type: 'text', text: 'kept answer' }]))
    );
    expect(projectHistory(text, 's').map((message) => message.text)).toEqual([
      'second try',
      'kept answer',
    ]);
  });

  it('marks failed tools, truncates long output and handles string content', () => {
    previous = null;
    const long = 'x'.repeat(HISTORY_TOOL_OUTPUT_CHARS + 50);
    const text = jsonl(
      header,
      entry('u1', { role: 'user', content: 'plain string prompt', timestamp: 1 }),
      entry(
        'a1',
        assistant([
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'false' } },
          { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'big.log' } },
        ])
      ),
      entry('r1', toolResult('c1', 'exit 1', { isError: true, durationMs: undefined })),
      entry('r2', toolResult('c2', long))
    );
    const [prompt, answer] = projectHistory(text, 's');
    expect(prompt?.text).toBe('plain string prompt');
    expect(answer?.toolCalls).toEqual([
      { id: 'c1', name: 'bash', args: { command: 'false' }, status: 'error', output: 'exit 1' },
      {
        id: 'c2',
        name: 'read',
        args: { path: 'big.log' },
        status: 'done',
        output: long.slice(0, HISTORY_TOOL_OUTPUT_CHARS),
        durationMs: 7,
      },
    ]);
  });

  it('reports a tool call without result as running only while the session runs', () => {
    previous = null;
    const text = jsonl(
      header,
      entry('u1', user('go')),
      entry('a1', assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }]))
    );
    expect(projectHistory(text, 's', { running: true })[1]?.toolCalls[0]?.status).toBe('running');
    expect(projectHistory(text, 's')[1]?.toolCalls[0]?.status).toBe('error');
  });

  it('skips malformed lines and entries it does not understand', () => {
    previous = null;
    const text = [
      JSON.stringify(header),
      '{ broken json',
      '',
      JSON.stringify(entry('u1', user('hi'))),
      JSON.stringify({ type: 'label', id: 'l1', parentId: 'u1', targetId: 'u1', label: 'x' }),
      JSON.stringify(entry('c1', { role: 'custom', customType: 'x', content: 'y' }, 'l1')),
      JSON.stringify(entry('a1', assistant([{ type: 'text', text: 'hello' }, 'garbage']))),
      '42',
    ].join('\n');
    expect(projectHistory(text, 's').map((message) => [message.role, message.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ]);
  });

  it('returns nothing for an empty or header-only file', () => {
    expect(projectHistory('', 's')).toEqual([]);
    expect(projectHistory(jsonl(header), 's')).toEqual([]);
  });
});

describe('readHistory', () => {
  let tmp = '';

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fynvra-history-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('places session files under <agentDir>/sessions and reads nothing for a new session', async () => {
    const file = sessionFilePath(join(tmp, 'agent'), 'session-9');
    expect(file).toBe(join(tmp, 'agent', 'sessions', 'session-9.jsonl'));
    await expect(readHistory(file, 'session-9')).resolves.toEqual([]);
  });

  it('projects a jsonl written by a real pi session through the worker adapter', async () => {
    const repo = join(tmp, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'a.txt'), 'hello');
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', reasoning: true }] });
    const runtime = await ModelRuntime.create({
      authPath: join(tmp, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const agentDir = join(tmp, 'agent');
    const file = sessionFilePath(agentDir, 'session-1');
    const open = createPiSessionFactory({
      agentDir,
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    });
    const session = await open({
      identity: { sessionId: 'session-1', generation: 1 },
      spec: {
        role: {
          id: 'reviewer',
          name: 'Reviewer',
          skillIds: [],
          mcpServerIds: [],
          tools: 'readonly',
          approvalMode: 'full',
        },
        cwd: repo,
        sessionFile: file,
        model: { providerId: 'faux', api: 'faux', modelId: 'faux-1' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          { type: 'thinking', thinking: 'look first' },
          { type: 'text', text: 'Listing.' },
          fauxToolCall('ls', { path: '.' }),
        ],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Found a.txt'),
    ]);
    await session.prompt('What is here?');
    await session.dispose();

    const messages = await readHistory(file, 'session-1');
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'What is here?'],
      ['assistant', 'Listing.'],
      ['assistant', 'Found a.txt'],
    ]);
    expect(messages[1]).toMatchObject({
      thinking: 'look first',
      toolCalls: [{ name: 'ls', args: { path: '.' }, status: 'done', output: 'a.txt' }],
    });
    expect(messages[1]?.toolCalls[0]?.durationMs).toEqual(expect.any(Number));
    expect(new Set(messages.map((message) => message.id)).size).toBe(3);
  });
});
