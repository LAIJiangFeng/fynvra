import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UsageRange, UsageSummaryResult } from '@shared/types/usage';

export interface UsageApi {
  summary(input: { range: UsageRange }): Promise<UsageSummaryResult>;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };

export function createUsageApi(ipc: Invoker): UsageApi {
  return { summary: (input) => ipc.invoke(IPC_CHANNELS.USAGE_SUMMARY, input) };
}
