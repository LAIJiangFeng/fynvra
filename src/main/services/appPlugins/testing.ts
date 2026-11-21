// 测试用：可注入的假插件进程（不 fork 任何东西）。
import type { AppPluginProcess, ForkAppPlugin } from './runtime';

export class FakePluginProcess implements AppPluginProcess {
  readonly sent: Record<string, unknown>[] = [];
  killed = false;
  exited = false;
  /** 收到 init 后自动回 activated */
  autoActivate = true;
  /** 收到 deactivate 后自动退出；false 模拟卡住 */
  exitOnDeactivate = true;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly exitListeners: ((code: number) => void)[] = [];
  private readonly outputListeners: ((stream: 'stdout' | 'stderr', text: string) => void)[] = [];

  constructor(readonly options: { pluginId: string; cwd: string; env: Record<string, string> }) {}

  postMessage(message: unknown): void {
    if (this.exited) throw new Error('process exited');
    const record = message as Record<string, unknown>;
    this.sent.push(record);
    if (record.type === 'init' && this.autoActivate) {
      queueMicrotask(() => this.emit({ type: 'activated' }));
    }
    if (record.type === 'deactivate' && this.exitOnDeactivate) {
      queueMicrotask(() => this.exit(0));
    }
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }
  onOutput(listener: (stream: 'stdout' | 'stderr', text: string) => void): void {
    this.outputListeners.push(listener);
  }
  kill(): void {
    this.killed = true;
    this.exit(-1);
  }
  /** 模拟插件发来的消息 */
  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
  output(stream: 'stdout' | 'stderr', text: string): void {
    for (const listener of this.outputListeners) listener(stream, text);
  }
  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code);
  }
}

export function createFakeFork(options: { autoActivate?: boolean } = {}): {
  fork: ForkAppPlugin;
  processes: FakePluginProcess[];
} {
  const processes: FakePluginProcess[] = [];
  return {
    processes,
    fork: (forkOptions) => {
      const process = new FakePluginProcess(forkOptions);
      process.autoActivate = options.autoActivate ?? true;
      processes.push(process);
      return process;
    },
  };
}
