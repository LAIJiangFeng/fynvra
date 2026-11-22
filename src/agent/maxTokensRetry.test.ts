import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { installMaxTokensRetry } from './maxTokensRetry';

type StreamFn = AgentSession['agent']['streamFunction'];

const ZHIPU_MAX_TOKENS =
  '400 {"error":{"message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]","type":"invalid_request_error"},"type":"error"}';

const MODEL = {
  id: 'glm-x',
  name: 'GLM',
  api: 'anthropic-messages',
  provider: 'fynvra-test',
  baseUrl: 'https://glm.example.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 200_000,
} as unknown as Model<Api>;

function message(patch: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...patch,
  } as AssistantMessage;
}

/** 一次请求的回答：rejected 带报错文字（可先流出一段文本），否则成功回答 ok */
type Reply = { error: string; textFirst?: boolean } | { text: string };

function streamOf(reply: Reply): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = message({});
    stream.push({ type: 'start', partial });
    if ('text' in reply || reply.textFirst) {
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hel', partial });
    }
    if ('error' in reply) {
      stream.push({
        type: 'error',
        reason: 'error',
        error: message({ stopReason: 'error', errorMessage: reply.error }),
      });
    } else {
      const done = message({ content: [{ type: 'text', text: reply.text }] });
      stream.push({ type: 'done', reason: 'stop', message: done });
    }
  });
  return stream;
}

function setup(replies: Reply[]) {
  const calls: { model: Model<Api>; maxTokens: number | undefined }[] = [];
  const inner = vi.fn<StreamFn>((model, _context, options) => {
    calls.push({ model, maxTokens: options?.maxTokens });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    return streamOf(reply);
  });
  const agent = { streamFunction: inner as StreamFn };
  const learned = vi.fn();
  installMaxTokensRetry(agent, learned);
  const request = async (signal?: AbortSignal) => {
    const stream = await agent.streamFunction(MODEL, { messages: [] } as never, {
      ...(signal ? { signal } : {}),
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return { events, result: await stream.result() };
  };
  return { calls, inner, learned, request };
}

describe('installMaxTokensRetry', () => {
  it('max_tokens 超范围时按端点上限静默重发一次，pi 只看到成功的回答', async () => {
    const { calls, learned, request } = setup([{ error: ZHIPU_MAX_TOKENS }, { text: 'ok' }]);
    const { events, result } = await request();
    expect(calls.map((call) => call.model.maxTokens)).toEqual([200_000, 131_072]);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_delta', 'done']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(result.stopReason).toBe('stop');
    expect(learned).toHaveBeenCalledTimes(1);
    expect(learned).toHaveBeenCalledWith(MODEL, 131_072);
  });

  it('之后的请求直接按降低后的上限发', async () => {
    const { calls, request } = setup([{ error: ZHIPU_MAX_TOKENS }, { text: 'ok' }, { text: 'ok' }]);
    await request();
    await request();
    expect(calls.map((call) => call.model.maxTokens)).toEqual([200_000, 131_072, 131_072]);
  });

  it('重发也失败时照常把报错交给 pi，只重发一次', async () => {
    const again = 'max_tokens must be less than or equal to 65536';
    const { calls, request } = setup([{ error: ZHIPU_MAX_TOKENS }, { error: again }]);
    const { events, result } = await request();
    expect(calls).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('error');
    expect(result.errorMessage).toBe(again);
  });

  it('已经流出内容、别的报错或已取消时不重发', async () => {
    const streamed = setup([{ error: ZHIPU_MAX_TOKENS, textFirst: true }]);
    expect((await streamed.request()).result.errorMessage).toBe(ZHIPU_MAX_TOKENS);
    expect(streamed.calls).toHaveLength(1);

    const other = setup([{ error: '429 rate limited' }]);
    const { events } = await other.request();
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(other.calls).toHaveLength(1);

    const aborted = setup([{ error: ZHIPU_MAX_TOKENS }]);
    const controller = new AbortController();
    controller.abort();
    expect((await aborted.request(controller.signal)).result.errorMessage).toBe(ZHIPU_MAX_TOKENS);
    expect(aborted.calls).toHaveLength(1);
    expect(aborted.learned).not.toHaveBeenCalled();
  });

  it('报的上限不比这次请求小时不重发', async () => {
    const { calls, request } = setup([
      { error: 'max_tokens must be less than or equal to 300000' },
    ]);
    expect((await request()).result.stopReason).toBe('error');
    expect(calls).toHaveLength(1);
  });
});
