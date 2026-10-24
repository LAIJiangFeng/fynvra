import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createEventNormalizer,
  type FynvraSessionEvent,
  subscribeNormalized,
  TOOL_OUTPUT_PREVIEW_CHARS,
} from './normalize';

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Hello ' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'text', text: 'world' },
    ],
    api: 'faux',
    provider: 'faux',
    model: 'faux-1',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: 'stop',
    timestamp: 1,
    ...overrides,
  };
}

function delta(type: 'text_delta' | 'thinking_delta', text: string): AgentSessionEvent {
  const partial = assistant();
  return {
    type: 'message_update',
    message: partial,
    assistantMessageEvent: { type, contentIndex: 0, delta: text, partial },
  };
}

describe('createEventNormalizer', () => {
  it('maps text and thinking deltas with increasing seq', () => {
    const normalizer = createEventNormalizer();
    expect([
      ...normalizer.push(delta('text_delta', 'Hi')),
      ...normalizer.push(delta('thinking_delta', 'pondering')),
    ]).toEqual([
      { type: 'text_delta', delta: 'Hi', seq: 1 },
      { type: 'thinking_delta', delta: 'pondering', seq: 2 },
    ]);
  });

  it('maps tool execution start and end, keeping a bounded output preview', () => {
    const normalizer = createEventNormalizer();
    const start = normalizer.push({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'a.ts' },
      parentToolCallId: 'p1',
    });
    const end = normalizer.push({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'read',
      result: {
        content: [{ type: 'text', text: 'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 10) }],
        details: undefined,
      },
      isError: false,
      durationMs: 12,
    });
    expect(start).toEqual([
      {
        type: 'tool_start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'a.ts' },
        parentToolCallId: 'p1',
        seq: 1,
      },
    ]);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({
      type: 'tool_end',
      toolCallId: 'c1',
      isError: false,
      outputTruncated: true,
      durationMs: 12,
      seq: 2,
    });
    expect((end[0] as { output: string }).output).toHaveLength(TOOL_OUTPUT_PREVIEW_CHARS);
  });

  it('turns an assistant message_end into message_end plus usage', () => {
    const normalizer = createEventNormalizer();
    expect(normalizer.push({ type: 'message_end', message: assistant() })).toEqual([
      { type: 'message_end', role: 'assistant', text: 'Hello world', stopReason: 'stop', seq: 1 },
      {
        type: 'usage',
        provider: 'faux',
        model: 'faux-1',
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: 0.003,
        seq: 2,
      },
    ]);
  });

  it('maps user messages and skips usage without tokens', () => {
    const normalizer = createEventNormalizer();
    const user = normalizer.push({
      type: 'message_end',
      message: { role: 'user', content: 'Do X', timestamp: 1 },
    });
    const empty = assistant({ usage: { ...assistant().usage, totalTokens: 0 } });
    const silent = normalizer.push({ type: 'message_end', message: empty });
    expect(user).toEqual([{ type: 'message_end', role: 'user', text: 'Do X', seq: 1 }]);
    expect(silent.map((event) => event.type)).toEqual(['message_end']);
  });

  it('reports a model error only once retries are exhausted', () => {
    const normalizer = createEventNormalizer();
    const failed = assistant({
      stopReason: 'error',
      errorMessage: '429 rate limited',
      content: [],
    });
    expect(normalizer.push({ type: 'agent_end', messages: [failed], willRetry: true })).toEqual([]);
    expect(normalizer.push({ type: 'agent_end', messages: [failed], willRetry: false })).toEqual([
      { type: 'error', source: 'model', message: '429 rate limited', seq: 1 },
    ]);
    expect(
      normalizer.push({ type: 'agent_end', messages: [assistant()], willRetry: false })
    ).toEqual([]);
  });

  it('reports failed compaction that will not be retried', () => {
    const normalizer = createEventNormalizer();
    expect(
      normalizer.push({
        type: 'compaction_end',
        reason: 'threshold',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'summary model unavailable',
      })
    ).toEqual([
      { type: 'error', source: 'compaction', message: 'summary model unavailable', seq: 1 },
    ]);
  });

  it('maps agent_settled', () => {
    expect(createEventNormalizer().push({ type: 'agent_settled', aborted: true })).toEqual([
      { type: 'agent_settled', aborted: true, seq: 1 },
    ]);
  });

  it('drops unknown and unmapped events, counting them by type without using seq', () => {
    const normalizer = createEventNormalizer();
    const partial = assistant();
    expect(normalizer.push({ type: 'turn_start' })).toEqual([]);
    expect(normalizer.push({ type: 'brand_new_pi_event' } as never)).toEqual([]);
    expect(
      normalizer.push({
        type: 'message_update',
        message: partial,
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{', partial },
      })
    ).toEqual([]);
    expect(normalizer.push({ type: 'message_end' } as never)).toEqual([]);
    expect(normalizer.push(null as never)).toEqual([]);
    expect(normalizer.stats()).toEqual({
      emitted: 0,
      dropped: 5,
      droppedByType: {
        turn_start: 1,
        brand_new_pi_event: 1,
        'message_update:toolcall_delta': 1,
        message_end: 1,
        unknown: 1,
      },
    });
    expect(normalizer.push({ type: 'agent_settled', aborted: false })[0]?.seq).toBe(1);
  });

  it('puts host events such as approval_request into the same seq stream', () => {
    const normalizer = createEventNormalizer();
    normalizer.push(delta('text_delta', 'a'));
    expect(
      normalizer.emit({
        type: 'approval_request',
        requestId: 'r1',
        toolCallId: 'c9',
        toolName: 'bash',
        args: { command: 'rm -rf build' },
      })
    ).toMatchObject({ type: 'approval_request', seq: 2 });
    expect(normalizer.stats().emitted).toBe(2);
  });
});

describe('subscribeNormalized', () => {
  function fakeSession() {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    return {
      session: {
        subscribe: (next: (event: AgentSessionEvent) => void) => {
          listener = next;
          return unsubscribe;
        },
      },
      fire: (event: AgentSessionEvent) => listener?.(event),
      unsubscribe,
    };
  }

  it('forwards normalized events and host events to the listener', () => {
    const { session, fire } = fakeSession();
    const seen: FynvraSessionEvent[] = [];
    const subscription = subscribeNormalized(session, (event) => seen.push(event));
    fire(delta('text_delta', 'Hi'));
    fire({ type: 'turn_start' });
    subscription.emit({ type: 'error', source: 'host', message: 'approval gate offline' });
    expect(seen.map((event) => [event.type, event.seq])).toEqual([
      ['text_delta', 1],
      ['error', 2],
    ]);
    expect(subscription.stats().droppedByType).toEqual({ turn_start: 1 });
  });

  it("never lets a throwing listener break pi's event dispatch", () => {
    const { session, fire } = fakeSession();
    const onListenerError = vi.fn();
    subscribeNormalized(
      session,
      () => {
        throw new Error('renderer bug');
      },
      { onListenerError }
    );
    expect(() => fire(delta('text_delta', 'Hi'))).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'renderer bug' })
    );
  });

  it('unsubscribes from the session', () => {
    const { session, unsubscribe } = fakeSession();
    subscribeNormalized(session, () => {}).unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
