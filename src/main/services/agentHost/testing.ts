import type { FynvraSessionEvent, FynvraSessionEventBody } from '@fynvra/core';
import { parseAgentCommand, type ResolvedModelSpec } from '@shared/types/agent';
import {
  type OpenSession,
  SessionSupervisor,
  type SupervisedSession,
  type SupervisorOptions,
} from '../../../agent/supervisor';
import type { WorkerProcess } from './workerClient';

// 测试用的进程内 agent worker 与脚本会话，只被 *.test.ts 引用。

/**
 * 进程内的 agent worker：命令与事件都走结构化克隆和两端的 parser，
 * 另一头是真实的 SessionSupervisor（会话由脚本代替 pi）。
 */
export class InMemoryWorker implements WorkerProcess {
  readonly supervisor: SessionSupervisor;
  #toMain: ((message: unknown) => void) | undefined;
  #onExit: ((code: number) => void) | undefined;

  constructor(openSession: OpenSession, options: Pick<SupervisorOptions, 'describeModels'> = {}) {
    this.supervisor = new SessionSupervisor({
      post: (event) => queueMicrotask(() => this.#toMain?.(structuredClone(event))),
      openSession,
      ...options,
    });
    queueMicrotask(() => this.#toMain?.({ type: 'ready' }));
  }

  postMessage(message: unknown): void {
    const command = parseAgentCommand(structuredClone(message));
    if (!command) throw new Error(`unparsable command: ${JSON.stringify(message)}`);
    queueMicrotask(() => {
      if (command.type === 'shutdown') {
        void this.supervisor.shutdown().then(() => this.#onExit?.(0));
        return;
      }
      this.supervisor.handle(command);
    });
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#toMain = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  kill(): void {
    this.#onExit?.(1);
  }
}

export type Emit = (event: FynvraSessionEventBody) => void;

/** 每次 prompt 运行一段脚本（代替模型 + 工具），结束时 settle */
export class ScriptedSession implements SupervisedSession {
  readonly warnings: string[] = [];
  /** set-model 交来的模型，按到达顺序 */
  readonly models: ResolvedModelSpec[] = [];
  #listener: ((event: FynvraSessionEvent) => void) | undefined;
  #seq = 0;
  #idle = true;
  constructor(private readonly script: (text: string, emit: Emit) => Promise<void>) {}

  subscribe(listener: (event: FynvraSessionEvent) => void) {
    this.#listener = listener;
    return { unsubscribe: () => (this.#listener = undefined), emit: this.#emit };
  }
  #emit: Emit = (event) => {
    this.#seq += 1;
    this.#listener?.({ ...event, seq: this.#seq } as FynvraSessionEvent);
  };
  async prompt(text: string): Promise<void> {
    this.#idle = false;
    this.#emit({ type: 'message_end', role: 'user', text });
    await this.script(text, this.#emit);
    this.#idle = true;
    this.#emit({ type: 'agent_settled', aborted: false });
  }
  async steer(): Promise<void> {}
  async setModel(spec: ResolvedModelSpec): Promise<void> {
    this.models.push(spec);
  }
  async abort(): Promise<void> {}
  isIdle(): boolean {
    return this.#idle;
  }
  async dispose(): Promise<void> {}
}
