import { useSyncExternalStore } from 'react';

// 全局共用一个计时器：列表里每行都显示相对时间，不必各开一个 interval
const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** 当前时间，约每 30 秒刷新一次；用于「3 分钟前」这类相对时间。 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
