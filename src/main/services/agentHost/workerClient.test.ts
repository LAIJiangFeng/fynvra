import type { AgentCommand } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerClient, type WorkerClientOptions, type WorkerProcess } from './workerClient';

class FakeProcess implements WorkerProcess {
  sent: unknown[] = [];
  kills = 0;
  #onMessage: ((message: unknown) => void) | undefined;
  #onExit: ((code: number) => void) | undefined;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#onMessage = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  kill(): void {
    this.kills += 1;
  }
  emit(message: unknown): void {
    this.#onMessage?.(message);
  }
  exit(code = 1): void {
    this.#onExit?.(code);
  }
}

const identity = { sessionId: 's1', generation: 1 };
const prompt = (text: string): AgentCommand => ({ type: 'prompt', identity, text });

function setup(options: Partial<WorkerClientOptions> = {}) {
  const processes: FakeProcess[] = [];
  const onEvent = vi.fn();
  const onStarted = vi.fn();
  const onCrash = vi.fn();
  const log = vi.fn();
  const client = createWorkerClient({
    fork: () => {
      const child = new FakeProcess();
      processes.push(child);
      return child;
    },
    onEvent,
    onStarted,
    onCrash,
    log,
    readyTimeoutMs: 5_000,
    maxRestarts: 2,
    restartWindowMs: 60_000,
    restartDelayMs: 1_000,
    ...options,
  });
  const current = () => processes.at(-1) as FakeProcess;
  return { client, processes, current, onEvent, onStarted, onCrash, log };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createWorkerClient', () => {
  it('queues commands until ready, flushes them in order, then posts directly', () => {
    const { client, current, onStarted } = setup();
    expect(client.state).toBe('stopped');
    expect(client.send(prompt('too early'))).toBe(false);
    client.start();
    expect(client.state).toBe('starting');
    expect(onStarted).toHaveBeenCalledWith({ restart: false });
    expect(client.send(prompt('a'))).toBe(true);
    expect(client.send(prompt('b'))).toBe(true);
    expect(current().sent).toEqual([]);

    current().emit({ type: 'ready' });
    expect(client.state).toBe('ready');
    expect(current().sent).toEqual([prompt('a'), prompt('b')]);
    client.send(prompt('c'));
    expect(current().sent.at(-1)).toEqual(prompt('c'));
  });

  it('forwards parsed events and logs messages that do not parse', () => {
    const { client, current, onEvent, log } = setup();
    client.start();
    current().emit({ type: 'ready' });
    current().emit({ type: 'session-status', identity, status: 'running' });
    current().emit({ type: 'session-status', identity, status: 'exploded' });
    current().emit('garbage');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'session-status', identity, status: 'running' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toBe('warn');
  });

  it('restarts after a crash, drops commands meant for the dead process and lets the caller re-spawn first', () => {
    const { client, processes, current, onCrash, onStarted } = setup();
    client.start();
    client.send(prompt('lost'));
    onStarted.mockImplementation(({ restart }: { restart: boolean }) => {
      if (restart) client.send(prompt('respawned first'));
    });
    current().exit(3);
    expect(onCrash).toHaveBeenCalledWith({ code: 3, willRestart: true });
    expect(client.state).toBe('restarting');
    expect(client.send(prompt('while down'))).toBe(false);

    vi.advanceTimersByTime(0);
    expect(processes).toHaveLength(2);
    expect(onStarted).toHaveBeenLastCalledWith({ restart: true });
    client.send(prompt('after restart'));
    current().emit({ type: 'ready' });
    expect(current().sent).toEqual([prompt('respawned first'), prompt('after restart')]);
    expect(processes[0]?.sent).toEqual([]);
  });

  it('backs off between crashes and gives up after too many in the window', () => {
    const { client, processes, current, onCrash } = setup();
    client.start();
    current().exit(1);
    vi.advanceTimersByTime(0);
    expect(processes).toHaveLength(2);

    current().exit(1);
    vi.advanceTimersByTime(999);
    expect(processes).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(processes).toHaveLength(3);

    current().exit(1);
    expect(onCrash).toHaveBeenLastCalledWith({ code: 1, willRestart: false });
    expect(client.state).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(processes).toHaveLength(3);

    // 手动 start 重置崩溃计数
    client.start();
    expect(processes).toHaveLength(4);
    expect(client.state).toBe('starting');
  });

  it('forgets crashes that are older than the window', () => {
    const { client, current, onCrash } = setup();
    client.start();
    current().exit(1);
    vi.advanceTimersByTime(61_000);
    current().exit(1);
    vi.advanceTimersByTime(61_000);
    current().exit(1);
    expect(onCrash).toHaveBeenLastCalledWith({ code: 1, willRestart: true });
  });

  it('kills a worker that does not become ready in time and treats it as a crash', () => {
    const { client, current, onCrash, log } = setup();
    client.start();
    const first = current();
    vi.advanceTimersByTime(5_000);
    expect(first.kills).toBe(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('did not become ready'));
    first.exit(1);
    expect(onCrash).toHaveBeenCalledWith({ code: 1, willRestart: true });
  });

  it('ignores events and exits of a process it already replaced', () => {
    const { client, processes, current, onEvent, onCrash } = setup();
    client.start();
    const first = current();
    first.exit(1);
    vi.advanceTimersByTime(0);
    first.emit({ type: 'session-status', identity, status: 'idle' });
    first.exit(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(processes).toHaveLength(2);
  });

  it('shuts down gracefully: sends shutdown, waits for the exit and does not restart', async () => {
    const { client, processes, current, onCrash } = setup();
    client.start();
    current().emit({ type: 'ready' });
    const done = client.shutdown(3_000);
    expect(current().sent.at(-1)).toEqual({ type: 'shutdown' });
    expect(client.send(prompt('late'))).toBe(false);
    current().exit(0);
    await done;
    expect(client.state).toBe('stopped');
    expect(onCrash).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(processes).toHaveLength(1);
  });

  it('kills a worker that ignores shutdown, and kills one that never became ready', async () => {
    const { client, current } = setup();
    client.start();
    current().emit({ type: 'ready' });
    const done = client.shutdown(3_000);
    vi.advanceTimersByTime(3_000);
    await done;
    expect(current().kills).toBe(1);
    expect(client.state).toBe('stopped');

    client.start();
    const starting = client.shutdown(3_000);
    expect(current().kills).toBe(1);
    expect(current().sent).toEqual([]);
    current().exit(1);
    await starting;
  });

  it('reports a failing post as not sent', () => {
    const { client, current, log } = setup();
    client.start();
    current().emit({ type: 'ready' });
    current().postMessage = () => {
      throw new Error('channel closed');
    };
    expect(client.send(prompt('x'))).toBe(false);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('channel closed'));
  });
});
