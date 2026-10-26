import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';

export type InstructionSource = 'claude' | 'codex' | 'gemini' | 'opencode' | 'home' | 'manual';

interface InstructionMetadata {
  id: string;
  name: string;
  source: InstructionSource;
  enabled: boolean;
  importedFrom?: string;
  createdAt: number;
  updatedAt: number;
}

export type InstructionEntry = InstructionMetadata &
  ({ kind: 'linked'; path: string } | { kind: 'local'; fileName: string });

/** Content is read live in Main; list responses contain only metadata and read diagnostics. */
export type InstructionView = InstructionEntry & {
  size: number;
  charCount: number;
  warning?: string;
};

export interface InstructionCandidate {
  id: string;
  name: string;
  source: InstructionSource;
  path: string;
  size: number;
  charCount: number;
  registered: boolean;
}

export interface InstructionScan {
  candidates: InstructionCandidate[];
  warnings: string[];
}

export interface InstructionDraft {
  id?: string;
  name: string;
  content: string;
}

export interface InstructionsApi {
  list(): Promise<IpcResult<{ entries: InstructionView[] }>>;
  read(id: string): Promise<IpcResult<{ entry: InstructionEntry; content: string }>>;
  scan(): Promise<IpcResult<InstructionScan>>;
  import(input: { candidateIds: string[] }): Promise<IpcResult<{ added: number; skipped: number }>>;
  /** Main picks a Markdown file; paths cannot be supplied by Renderer. */
  pick(): Promise<IpcResult<{ canceled: boolean }>>;
  save(input: InstructionDraft): Promise<IpcResult>;
  remove(id: string): Promise<IpcResult>;
  toggle(input: { id: string; enabled: boolean }): Promise<IpcResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

export function createInstructionsApi(ipc: Invoker, subscribe: Subscribe): InstructionsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_LIST),
    read: (id) => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_READ, id),
    scan: () => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_SCAN),
    import: (input) => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_IMPORT, input),
    pick: () => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_PICK),
    save: (input) => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_SAVE, input),
    remove: (id) => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_REMOVE, id),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.INSTRUCTIONS_CHANGED, () => callback()),
  };
}
