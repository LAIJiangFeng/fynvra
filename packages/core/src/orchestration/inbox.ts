import type { Message, MessageType } from '../types';
import { newId } from './ids';
import { type EntityTable, InMemoryOrchestrationStore } from './store';

/**
 * 消息过滤条件；给出的条件之间是 AND。`types` 只匹配列出的类型（空数组不匹配任何消息），省略则不限。
 */
export interface MessageFilter {
  runId?: string;
  dispatchId?: string;
  from?: string;
  to?: string;
  replyTo?: string;
  types?: readonly MessageType[];
}

/** 过滤条件或谓词函数。谓词抛异常视为不匹配。 */
export type MessageQuery = MessageFilter | ((message: Message) => boolean);

/** {@link Inbox.post} 的入参：`id`、`createdAt` 由收件箱分配，新消息总是未确认。 */
export type NewMessage = Omit<Message, 'id' | 'createdAt' | 'ackedAt'>;

/** {@link Inbox.post} / {@link Inbox.ack} 的结果。 */
export type InboxResult = { ok: true; message: Message } | { ok: false; error: string };

/** {@link Inbox} 构造参数。 */
export interface InboxOptions {
  /** 消息表；传 `store.messages` 让消息随编排快照持久化。默认新建内存表。 */
  messages?: EntityTable<Message>;
  /** 时钟（epoch ms），默认 `Date.now`。 */
  now?: () => number;
}

// setTimeout 的上限（约 24.8 天），更大的值会被 Node 当成 1ms
const MAX_TIMER_DELAY = 2_147_483_647;

interface Waiter {
  matches: (message: Message) => boolean;
  settle: (message: Message | null) => void;
}

function toPredicate(query: MessageQuery): (message: Message) => boolean {
  if (typeof query === 'function') {
    return (message) => {
      try {
        return query(message) === true;
      } catch {
        return false;
      }
    };
  }
  const { runId, dispatchId, from, to, replyTo, types } = query;
  return (message) =>
    (runId === undefined || message.runId === runId) &&
    (dispatchId === undefined || message.dispatchId === dispatchId) &&
    (from === undefined || message.from === from) &&
    (to === undefined || message.to === to) &&
    (replyTo === undefined || message.replyTo === replyTo) &&
    (types === undefined || types.includes(message.type));
}

/**
 * 编排收件箱：worker ↔ coordinator 的 FIFO 消息队列。
 *
 * 消息在 {@link Inbox.ack} 之前一直可见（`peek` / `waitFor` 都不消费），
 * 处理完再确认，崩溃重启后未确认的消息还会再次交付。
 */
export class Inbox {
  readonly #messages: EntityTable<Message>;
  readonly #now: () => number;
  readonly #waiters = new Set<Waiter>();

  constructor(options: InboxOptions = {}) {
    this.#messages = options.messages ?? new InMemoryOrchestrationStore().messages;
    this.#now = options.now ?? Date.now;
  }

  /** 投递一条消息并唤醒所有匹配的等待者；类型非法时返回错误。 */
  post(message: NewMessage): InboxResult {
    const result = this.#messages.insert({
      ...message,
      id: newId('msg'),
      createdAt: this.#now(),
      ackedAt: undefined,
    });
    if (!result.ok) return result;
    for (const waiter of [...this.#waiters]) {
      if (waiter.matches(result.value)) waiter.settle(structuredClone(result.value));
    }
    return { ok: true, message: result.value };
  }

  /** 按 FIFO 返回匹配的未确认消息（不消费）。 */
  peek(query: MessageQuery = {}): Message[] {
    const matches = toPredicate(query);
    return this.#messages.list((message) => message.ackedAt === undefined && matches(message));
  }

  /** 确认消息；重复确认幂等（保留首次确认时间），未知 id 返回错误。 */
  ack(id: string): InboxResult {
    const message = this.#messages.get(id);
    if (message === undefined) return { ok: false, error: `message ${id} not found` };
    if (message.ackedAt !== undefined) return { ok: true, message };
    const result = this.#messages.update(id, { ackedAt: this.#now() });
    return result.ok ? { ok: true, message: result.value } : result;
  }

  /**
   * 等第一条匹配的未确认消息：已有则立即返回最早的一条，否则等到它被 `post`。
   * 超时返回 `null`，从不 reject；不会自动确认。`timeoutMs` ≤ 0 或非数字时只检查一次不等待，
   * `Infinity` 表示一直等。
   * 多个等待者匹配同一条消息时都会拿到它。
   */
  waitFor(query: MessageQuery, timeoutMs: number): Promise<Message | null> {
    const matches = toPredicate(query);
    const [existing] = this.peek(matches);
    if (existing !== undefined) return Promise.resolve(existing);
    if (!(timeoutMs > 0)) return Promise.resolve(null);

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        matches,
        settle: (message) => {
          this.#waiters.delete(waiter);
          if (timer !== undefined) clearTimeout(timer);
          resolve(message);
        },
      };
      this.#waiters.add(waiter);
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => waiter.settle(null), Math.min(timeoutMs, MAX_TIMER_DELAY));
      }
    });
  }
}
