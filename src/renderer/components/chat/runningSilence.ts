import type { ChatMessage, SessionStatus } from '@shared/types/chat';

const SILENCE_MS = 800;

export interface RunningActivity {
  sessionId: string;
  status: SessionStatus;
  bodyId: string;
  text: string;
}

/** 只看最近的 assistant 正文；用户回显、空占位、思考、工具和 streaming 收尾不算更新。 */
export function runningActivityOf(
  sessionId: string,
  status: SessionStatus,
  messages: readonly ChatMessage[]
): RunningActivity {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.text.trim()) {
      return { sessionId, status, bodyId: message.id, text: message.text };
    }
  }
  return { sessionId, status, bodyId: '', text: '' };
}

export function sameRunningActivity(a: RunningActivity, b: RunningActivity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.status === b.status &&
    a.bodyId === b.bodyId &&
    a.text === b.text
  );
}

/** 由投影变化驱动，最多一个可取消的 timeout；到期还要读取最新投影。 */
export function createRunningSilence(
  readActivity: () => RunningActivity,
  onChange: (silent: RunningActivity | undefined) => void
): { update: () => void; dispose: () => void } {
  let current: RunningActivity | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;

  const cancel = () => {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    update() {
      if (disposed) return;
      const next = readActivity();
      if (current && sameRunningActivity(current, next)) return;
      cancel();
      current = next;
      onChange(undefined);
      if (next.status !== 'running') return;
      const request = generation;
      timer = setTimeout(() => {
        if (request !== generation) return;
        timer = undefined;
        if (sameRunningActivity(next, readActivity())) onChange(next);
      }, SILENCE_MS);
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
