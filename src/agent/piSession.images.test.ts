import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { FynvraSessionEvent } from '@fynvra/core';
import type { ChatImage } from '@shared/types/chat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiSessionFactory } from './piSession';

// 真实的 pi 会话（faux 模型）：单独成文件，不受其他用例对 createRoleSession 的 mock 影响。

// 1×1 的 PNG：在 pi 的尺寸与大小上限之内，pi 原样发出、不加提示行
const PIXEL: ChatImage = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
};
const PIXEL_CONTENT = { type: 'image', data: PIXEL.data, mimeType: PIXEL.mimeType };

describe('createPiSessionFactory images', () => {
  let tmp = '';
  let faux: FauxProviderHandle;
  let runtime: ModelRuntime;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fynvra-pi-session-images-'));
    await mkdir(join(tmp, 'repo'), { recursive: true });
    faux = fauxProvider({ provider: 'fynvra-faux', models: [{ id: 'faux-vision' }] });
    runtime = await ModelRuntime.create({
      authPath: join(tmp, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function open(sessionId: string) {
    return createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    })({
      identity: { sessionId, generation: 1 },
      spec: {
        role: {
          id: 'worker',
          name: 'Worker',
          skillIds: [],
          mcpServerIds: [],
          tools: 'readonly',
          approvalMode: 'full',
        },
        cwd: join(tmp, 'repo'),
        sessionFile: join(tmp, 'agent', 'sessions', `${sessionId}.jsonl`),
        compactionStrategy: 'native',
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-vision' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
  }

  /** 每次请求里 user 消息的内容（provider 收到的，即 convertToLlm 之后） */
  function answering(...replies: string[]) {
    const requests: unknown[][] = [];
    faux.setResponses(
      replies.map((reply) => (context: { messages: Message[] }) => {
        requests.push(
          structuredClone(context.messages.filter((message) => message.role === 'user')).map(
            (message) => message.content
          )
        );
        return fauxAssistantMessage(reply);
      })
    );
    return requests;
  }

  it('sends the pasted images to the model with the text of the message', async () => {
    const session = await open('s1');
    const events: FynvraSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const requests = answering('A single pixel.');
    try {
      await session.prompt('What is in this image?', [PIXEL]);
    } finally {
      await session.dispose();
    }
    expect(requests).toEqual([[[{ type: 'text', text: 'What is in this image?' }, PIXEL_CONTENT]]]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message_end', role: 'user', text: 'What is in this image?' })
    );
  });

  it('sends a message with only images without an empty text block, on every later turn too', async () => {
    const session = await open('s2');
    const events: FynvraSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const requests = answering('A single pixel.', 'Yes.');
    try {
      await session.prompt('', [PIXEL]);
      await session.prompt('Is it transparent?');
    } finally {
      await session.dispose();
    }
    // Gemini 等拒绝空的 text part：这条消息在之后每一轮的上下文里都只剩图片
    expect(requests).toEqual([
      [[PIXEL_CONTENT]],
      [[PIXEL_CONTENT], [{ type: 'text', text: 'Is it transparent?' }]],
    ]);
    expect(events.filter((event) => event.type === 'message_end' && event.role === 'user')).toEqual(
      [
        expect.objectContaining({ text: '' }),
        expect.objectContaining({ text: 'Is it transparent?' }),
      ]
    );
    // jsonl 仍是 pi 自己的形状（空文本块 + 图片），只在发给 provider 之前去掉空块
    const lines = (await readFile(join(tmp, 'agent', 'sessions', 's2.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { type: string; message?: { role: string; content: unknown } }
      );
    expect(
      lines.find((line) => line.type === 'message' && line.message?.role === 'user')?.message
        ?.content
    ).toEqual([{ type: 'text', text: '' }, PIXEL_CONTENT]);
  });
});
