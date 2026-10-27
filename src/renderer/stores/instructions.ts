import { create } from 'zustand';
import { instructionCall, instructionsApi } from '@/lib/api/instructions';
import type { InstructionView } from '../../preload/domains/instructions';

interface InstructionsState {
  entries: InstructionView[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

let revision = 0;
export const useInstructionsStore = create<InstructionsState>()((set) => ({
  entries: [],
  loaded: false,
  error: null,
  async refresh() {
    const current = ++revision;
    const result = await instructionCall(() => instructionsApi.list());
    if (current !== revision) return;
    set(
      result.ok
        ? { entries: result.entries, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
  },
}));

instructionsApi.onChanged(() => {
  void useInstructionsStore.getState().refresh();
});
