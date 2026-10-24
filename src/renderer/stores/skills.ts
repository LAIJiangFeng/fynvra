import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { SkillEntry } from '@shared/types/llm';
import { create } from 'zustand';
import type {
  SkillAddResult,
  SkillScanResult,
  SkillToggleResult,
} from '../../preload/domains/skills';

export interface SkillsState {
  skills: SkillEntry[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** 无参：Main 弹目录选择框；传 candidateIds：登记扫描结果 */
  add(input?: { candidateIds: string[] }): Promise<SkillAddResult>;
  remove(id: string): Promise<IpcResult>;
  toggle(id: string, enabled: boolean): Promise<SkillToggleResult>;
  scan(): Promise<SkillScanResult>;
}

const api = window.fynvra.skills;

async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
  skills: [],
  loaded: false,
  error: null,

  async refresh() {
    const result = await safely(() => api.list());
    set(
      result.ok
        ? { skills: result.skills, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
  },

  async add(input) {
    let result: SkillAddResult;
    try {
      result = await api.add(input);
    } catch (error) {
      result = { ok: false, code: 'failed', error: errorMessage(error) };
    }
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

  scan: () => safely(() => api.scan()),
}));

api.onChanged(() => {
  void useSkillsStore.getState().refresh();
});
void useSkillsStore.getState().refresh();
