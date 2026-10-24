import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import { Inbox, type NewMessage } from './inbox';
import { InMemoryOrchestrationStore } from './store';

const base: NewMessage = {
  runId: 'run_1',
  dispatchId: 'dispatch_1',
  from: 'session_w',
  to: 'session_c',
  type: 'question',
  body: 'Which port?',
};

function createInbox() {
  let clock = 1_000;
  const store = new InMemoryOrchestrationStore();
  const inbox = new Inbox({ messages: store.messages, now: () => clock++ });
  return { inbox, store };
}

function post(inbox: Inbox, overrides: Partial<NewMessage> = {}): Message {
  const result = inbox.post({ ...base, ...overrides });
  if (!result.ok) throw new Error(result.error);
  return result.message;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Inbox.post', () => {
  it('分配 id 与 createdAt，写入注入的消息表（随快照持久化）', () => {
    const { inbox, store } = createInbox();
    const message = post(inbox);
    expect(message).toEqual({ ...base, id: message.id, createdAt: 1_000 });
    expect(message.id).toMatch(/^msg_/);
    expect(store.snapshot().messages).toEqual([message]);
  });

  it('非法类型返回错误且不入库', () => {
    const { inbox, store } = createInbox();
    const result = inbox.post({ ...base, type: 'ping' as NewMessage['type'] });
    expect(result.ok).toBe(false);
    expect(store.messages.list()).toEqual([]);
  });

  it('入参里的 ackedAt 被忽略：新消息总是未确认', () => {
    const { inbox } = createInbox();
    const message = post(inbox, { ackedAt: 5 } as Partial<NewMessage>);
    expect(message.ackedAt).toBeUndefined();
    expect(inbox.peek()).toEqual([message]);
  });

  it('默认自带内存消息表', () => {
    const inbox = new Inbox();
    const result = inbox.post(base);
    expect(result.ok && inbox.peek()).toEqual([result.ok && result.message]);
  });
});

describe('Inbox.peek', () => {
  it('FIFO 返回未确认的消息', () => {
    const { inbox } = createInbox();
    const first = post(inbox, { body: '1' });
    const second = post(inbox, { body: '2' });
    expect(inbox.peek()).toEqual([first, second]);
  });

  it('按类型 / 收件人 / 发件人 / run / dispatch / replyTo 过滤，条件之间是 AND', () => {
    const { inbox } = createInbox();
    const question = post(inbox);
    const done = post(inbox, { type: 'worker_done', body: 'Done.' });
    const reply = post(inbox, {
      type: 'reply',
      from: 'session_c',
      to: 'session_w',
      replyTo: question.id,
      body: '5173',
    });
    const otherRun = post(inbox, { runId: 'run_2', dispatchId: 'dispatch_9' });

    expect(inbox.peek({ types: ['worker_done', 'question'] })).toEqual([question, done, otherRun]);
    expect(inbox.peek({ to: 'session_w' })).toEqual([reply]);
    expect(inbox.peek({ from: 'session_c' })).toEqual([reply]);
    expect(inbox.peek({ runId: 'run_2' })).toEqual([otherRun]);
    expect(inbox.peek({ dispatchId: 'dispatch_1', types: ['worker_done'] })).toEqual([done]);
    expect(inbox.peek({ replyTo: question.id })).toEqual([reply]);
    expect(inbox.peek({ types: [] })).toEqual([]);
  });

  it('也接受谓词函数', () => {
    const { inbox } = createInbox();
    post(inbox, { body: 'short' });
    const long = post(inbox, { body: 'a much longer body' });
    expect(inbox.peek((message) => message.body.length > 10)).toEqual([long]);
  });
});

describe('Inbox.ack', () => {
  it('确认后不再出现在 peek 里；重复确认幂等', () => {
    const { inbox, store } = createInbox();
    const message = post(inbox);
    const acked = inbox.ack(message.id);
    expect(acked).toEqual({ ok: true, message: { ...message, ackedAt: 1_001 } });
    expect(inbox.peek()).toEqual([]);
    expect(inbox.ack(message.id)).toEqual(acked);
    expect(store.messages.get(message.id)?.ackedAt).toBe(1_001);
  });

  it('未知 id 返回错误', () => {
    const { inbox } = createInbox();
    const result = inbox.ack('msg_missing');
    expect(!result.ok && result.error).toMatch(/not found/);
  });
});

describe('Inbox.waitFor', () => {
  it('已有匹配的未确认消息时立即返回最早的一条', async () => {
    const { inbox } = createInbox();
    const first = post(inbox, { type: 'worker_done' });
    post(inbox, { type: 'worker_done' });
    await expect(inbox.waitFor({ types: ['worker_done'] }, 10)).resolves.toEqual(first);
  });

  it('等到匹配的消息被 post；不匹配的消息不会唤醒；不自动 ack', async () => {
    vi.useFakeTimers();
    const { inbox } = createInbox();
    const question = post(inbox);
    const waiting = inbox.waitFor({ types: ['reply'], replyTo: question.id }, 60_000);
    post(inbox, { type: 'reply', replyTo: 'msg_other' });
    post(inbox, { type: 'heartbeat' });
    const reply = post(inbox, { type: 'reply', replyTo: question.id, body: '5173' });
    await expect(waiting).resolves.toEqual(reply);
    expect(inbox.peek({ types: ['reply'], replyTo: question.id })).toEqual([reply]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时返回 null 而不是抛异常，并清理等待者', async () => {
    vi.useFakeTimers();
    const { inbox } = createInbox();
    const waiting = inbox.waitFor({ types: ['worker_done'] }, 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    post(inbox, { type: 'question' });
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // 超时后的消息不会再交给已经结束的等待
    post(inbox, { type: 'worker_done' });
    await expect(waiting).resolves.toBeNull();
  });

  it('timeoutMs ≤ 0 或非数字时只检查一次，不等待', async () => {
    vi.useFakeTimers();
    const { inbox } = createInbox();
    for (const timeout of [0, -1, Number.NaN]) {
      await expect(inbox.waitFor({ types: ['reply'] }, timeout)).resolves.toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('多个等待者都能收到同一条匹配的消息', async () => {
    const { inbox } = createInbox();
    const a = inbox.waitFor({ types: ['escalation'] }, 1_000);
    const b = inbox.waitFor((message) => message.to === 'session_c', 1_000);
    const escalation = post(inbox, { type: 'escalation', body: 'Need a decision' });
    await expect(Promise.all([a, b])).resolves.toEqual([escalation, escalation]);
  });

  it('抛异常的谓词视为不匹配，不影响 post 与其他等待者', async () => {
    const { inbox } = createInbox();
    const broken = inbox.waitFor(() => {
      throw new Error('bad predicate');
    }, 20);
    const healthy = inbox.waitFor({ types: ['question'] }, 1_000);
    const result = inbox.post(base);
    expect(result.ok).toBe(true);
    await expect(healthy).resolves.toEqual(result.ok && result.message);
    await expect(broken).resolves.toBeNull();
  });
});
