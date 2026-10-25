export interface Coalescer<T> {
  /** 排一条；同一 key 窗口内的后来者顶替先到的 */
  push(key: string, item: T): void;
  /** 丢掉还没发出的（退出时） */
  clear(): void;
}

/**
 * 按 key 合并：同一 key 的第一条开始计时，`windowMs` 后只发出窗口内的最后一条。
 * 窗口不随后来者顺延，连续不断的消息最多晚一个窗口。
 */
export function createCoalescer<T>(options: {
  windowMs: number;
  emit: (item: T) => void;
}): Coalescer<T> {
  const pending = new Map<string, { item: T; timer: ReturnType<typeof setTimeout> }>();

  return {
    push(key, item) {
      const waiting = pending.get(key);
      if (waiting) {
        waiting.item = item;
        return;
      }
      const timer = setTimeout(() => {
        const due = pending.get(key);
        pending.delete(key);
        if (due) options.emit(due.item);
      }, options.windowMs);
      pending.set(key, { item, timer });
    },
    clear() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
