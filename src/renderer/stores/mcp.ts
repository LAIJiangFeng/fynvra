import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { McpServerEntryView } from '@shared/types/llm';
import { create } from 'zustand';
import type { McpImportResult, McpSaveResult, McpUpsertInput } from '../../preload/domains/mcp';

export interface McpState {
  /** env / headers 只有键名 */
  servers: McpServerEntryView[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  upsert(input: McpUpsertInput): Promise<McpSaveResult>;
  remove(id: string): Promise<IpcResult>;
  toggle(id: string, enabled: boolean): Promise<McpSaveResult>;
  importClaude(): Promise<McpImportResult>;
}

const api = window.fynvra.mcp;

async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const useMcpStore = create<McpState>()((set, get) => ({
  servers: [],
  loaded: false,
  error: null,

  async refresh() {
    const result = await safely(() => api.list());
    set(
      result.ok
        ? { servers: result.servers, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
  },

  async upsert(input) {
    const result = await safely(() => api.upsert(input));
    if (result.ok) await get().refresh();
    return result;
  },

  async remove(id) {
    const result = await safely(() => api.remove(id));
    if (result.ok) await get().refresh();
    return result;
  },

  async toggle(id, enabled) {
    const result = await safely(() => api.toggle({ id, enabled }));
    if (result.ok) await get().refresh();
    return result;
  },

  async importClaude() {
    const result = await safely(() => api.importClaude());
    if (result.ok) await get().refresh();
    return result;
  },
}));

api.onChanged(() => {
  void useMcpStore.getState().refresh();
});
void useMcpStore.getState().refresh();
