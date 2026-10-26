import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { USAGE_RANGES, type UsageRange, type UsageSummaryResult } from '@shared/types/usage';
import { app, ipcMain } from 'electron';
import { translate } from '../i18n';
import { UsageService } from '../services/usage/service';

let service: UsageService | null = null;

export function parseUsageInput(raw: unknown): { range: UsageRange } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'range')) return null;
  const range = USAGE_RANGES.find((value) => value === record.range);
  return range ? { range } : null;
}

export function registerUsageHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.USAGE_SUMMARY,
    async (_event, raw: unknown): Promise<UsageSummaryResult> => {
      const input = parseUsageInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      try {
        service ??= new UsageService(join(app.getPath('userData'), 'agent', 'sessions'));
        return { ok: true, summary: await service.summary(input.range) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
