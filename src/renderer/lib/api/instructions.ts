import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { InstructionsApi } from '../../../preload/domains/instructions';

export const instructionsApi: InstructionsApi = window.fynvra.instructions;

export async function instructionCall<T extends object>(
  call: () => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
