import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { FynvraSessionEvent } from '@fynvra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiSessionFactory } from '../../../agent/piSession';
import {
  HISTORY_TOOL_OUTPUT_CHARS,
  projectHistory,
  projectHistoryProjection,
  readHistory,
  readHistoryProjection,
  sessionFilePath,
} from './history';

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

  it('collects the images of user messages and strips the hint lines pi appended to their text', () => {
    previous = null;
    const png = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const webp = { type: 'image', data: 'UklGRg==', mimeType: 'image/webp' };
    const resized =
      '[Image: original 3773x1017, displayed at 2000x539. Multiply coordinates by 1.89 to map to original image.]';
    const converted = '[Image converted from image/heic to image/png.]';
    const userWith = (text: string, ...images: unknown[]) => ({
      role: 'user',
      content: [{ type: 'text', text }, ...images],
      timestamp: 1_000,
    });
    const text = jsonl(
      header,
      entry('u1', userWith(`What is wrong here?\n\n${resized}`, png)),
      entry('a1', assistant([{ type: 'text', text: 'A typo.' }])),
      // 只有图片：剥掉 pi 接上的提示行后正文为空
      entry('u2', userWith(`\n\n${converted}\n${resized}`, png, webp)),
      entry('u3', userWith('', png)),
      // 格式不在白名单里、data 不是字符串的图片块不收；一张都没收下就按没有图片处理
      entry(
        'u4',
        userWith(
          'odd blocks',
          { type: 'image', data: 'Qk0=', mimeType: 'image/bmp' },
          { type: 'image', data: 42, mimeType: 'image/png' },
          { type: 'image', mimeType: 'image/png' }
        )
      ),
      // 没有图片的消息：形似提示行的文字是用户自己写的，不剥
      entry('u5', user(`Explain this line:\n\n${resized}`))
    );
    const messages = projectHistory(text, 's');
    const image = ({ data, mimeType }: { data: string; mimeType: string }) => ({ data, mimeType });
    expect(messages.map(({ role, text, images }) => ({ role, text, images }))).toEqual([
      { role: 'user', text: 'What is wrong here?', images: [image(png)] },
      { role: 'assistant', text: 'A typo.', images: undefined },
      { role: 'user', text: '', images: [image(png), image(webp)] },
      { role: 'user', text: '', images: [image(png)] },
      { role: 'user', text: 'odd blocks', images: undefined },
      { role: 'user', text: `Explain this line:\n\n${resized}`, images: undefined },
    ]);
    expect(messages[1]).not.toHaveProperty('images');
    expect(messages[4]).not.toHaveProperty('images');
  });
});

describe('history recovery hint', () => {
  const checkpoint = (id: string, parentId: string, blocked: unknown, pending: unknown = []) => ({
    type: 'custom',
    id,
    parentId,
    customType: 'fynvra-context-recovery',
    data: { blocked, pending, effectiveStrategy: 'must not expose engine information' },
  });
  it('uses only the current branch and exposes just the recovery boolean', () => {
    const text = jsonl(
      header,
      entry('root', user('visible input'), null),
      checkpoint('active', 'root', true, [{ text: 'private held input' }]),
      checkpoint('other-branch', 'root', false),
      entry('leaf', assistant([{ type: 'text', text: 'current branch' }]), 'active')
    );
    const projected = projectHistoryProjection(text, 's');
    expect(projected.contextRecovery).toEqual({ recoveryRequired: true });
    expect(projected.messages.map((message) => message.text)).toEqual([
      'visible input',
      'current branch',
    ]);
    expect(JSON.stringify(projected)).not.toContain('private held input');
    expect(JSON.stringify(projected)).not.toContain('effectiveStrategy');
  });
  it('does not inherit a checkpoint from another branch', () => {
    const text = jsonl(
      header,
      entry('root', user('input'), null),
      checkpoint('abandoned', 'root', true),
      entry('leaf', assistant([{ type: 'text', text: 'ordinary conversation' }]), 'root')
    );
    expect(projectHistoryProjection(text, 's').contextRecovery).toBeUndefined();
  });
  it('uses the last valid checkpoint and reports false after recovery completes', () => {
    const text = jsonl(
      header,
      entry('root', user('input'), null),
      checkpoint('blocked', 'root', true),
      checkpoint('completed', 'blocked', false),
      checkpoint('invalid-boolean', 'completed', 'true'),
      checkpoint('invalid-pending', 'invalid-boolean', true, null)
    );
    expect(projectHistoryProjection(text, 's').contextRecovery).toEqual({
      recoveryRequired: false,
    });
    expect(
      projectHistoryProjection(jsonl(header, entry('ordinary', user('input'), null)), 's')
        .contextRecovery
    ).toBeUndefined();
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
    await expect(readHistoryProjection(file, 'session-9')).resolves.toEqual({ messages: [] });
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
        compactionStrategy: 'native',
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

  it('projects the images pi stored and the text without the hint pi appended after resizing', async () => {
    const repo = join(tmp, 'repo-images');
    await mkdir(repo, { recursive: true });
    const faux = fauxProvider({ provider: 'faux-vision', models: [{ id: 'faux-2' }] });
    const runtime = await ModelRuntime.create({
      authPath: join(tmp, 'auth-images.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const agentDir = join(tmp, 'agent');
    const file = sessionFilePath(agentDir, 'session-2');
    const session = await createPiSessionFactory({
      agentDir,
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    })({
      identity: { sessionId: 'session-2', generation: 1 },
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
        compactionStrategy: 'native',
        model: { providerId: 'faux-vision', api: 'faux', modelId: 'faux-2' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    const events: FynvraSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    faux.setResponses([fauxAssistantMessage('A black line.')]);
    // 2100×1：比 pi 的 2000 px 上限宽，pi 缩小后在正文后面接上提示行
    await session.prompt('What is this?', [{ data: grayPng(2100, 1), mimeType: 'image/png' }]);
    await session.dispose();

    const delivered = events.find((event) => event.type === 'message_end' && event.role === 'user');
    expect(delivered).toMatchObject({
      text: 'What is this?\n\n[Image: original 2100x1, displayed at 2000x1. Multiply coordinates by 1.05 to map to original image.]',
    });
    const [question, answer] = await readHistory(file, 'session-2');
    expect(question).toMatchObject({
      role: 'user',
      text: 'What is this?',
      images: [
        { data: expect.any(String), mimeType: expect.stringMatching(/^image\/(png|jpeg)$/) },
      ],
    });
    expect(answer).toMatchObject({ role: 'assistant', text: 'A black line.' });
  });
});

/** width×height 的全黑 8 位灰度 PNG（base64）：用来造一张超过 pi 尺寸上限的图 */
function grayPng(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深 8；颜色类型（灰度）、压缩、过滤、隔行方式都是 0
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    // 每行一个过滤字节（0）加 width 个像素（0，黑色）
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
