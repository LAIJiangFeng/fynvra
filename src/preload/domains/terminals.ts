import { asRecord } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { TerminalCreateRequest, TerminalEvent } from '@shared/types/terminal';
import type { Unsubscribe } from '../types';

export interface TerminalsApi {
  create(input: TerminalCreateRequest): Promise<IpcResult>;
  write(id: string, data: string): Promise<IpcResult>;
  resize(id: string, cols: number, rows: number): Promise<IpcResult>;
  close(id: string): Promise<IpcResult>;
  onEvent(callback: (event: TerminalEvent) => void): Unsubscribe;
}

export function createTerminalsApi(
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> },
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => Unsubscribe
): TerminalsApi {
  return {
    create: (input) => ipc.invoke(IPC_CHANNELS.TERMINALS_CREATE, input) as Promise<IpcResult>,
    write: (id, data) => ipc.invoke(IPC_CHANNELS.TERMINALS_WRITE, { id, data }) as Promise<IpcResult>,
    resize: (id, cols, rows) => ipc.invoke(IPC_CHANNELS.TERMINALS_RESIZE, { id, cols, rows }) as Promise<IpcResult>,
    close: (id) => ipc.invoke(IPC_CHANNELS.TERMINALS_CLOSE, { id }) as Promise<IpcResult>,
    onEvent: (callback) => subscribe(IPC_CHANNELS.TERMINALS_EVENT, (raw) => {
      const event = asRecord(raw);
      if (!event || typeof event.id !== 'string') return;
      if (event.type === 'data' && typeof event.data === 'string')
        callback({ id: event.id, type: 'data', data: event.data });
      else if (event.type === 'exit' && typeof event.exitCode === 'number')
        callback({ id: event.id, type: 'exit', exitCode: event.exitCode });
    }),
  };
}
