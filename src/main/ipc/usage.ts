import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { USAGE_RANGES, type UsageRange, type UsageSummaryResult } from '@shared/types/usage';
import { app, ipcMain } from 'electron';
import { translate } from '../i18n';
import type { OrchestrationRegistry } from '../services/orchestration/registry';
import type { SessionStore } from '../services/sessions/sessionStore';
import type { UsageSnapshot } from '../services/usage/orchestration';
import { readUsageFile, UsageService } from '../services/usage/service';
import type { WorkspaceService } from '../services/workspaces';
import { getOrchestrationRegistry } from './orchestration';
import { getSessionStore } from './sessions';
import { getWorkspaceService } from './workspaces';

interface UsageDependencies {
  getSessions: () => Pick<SessionStore, 'all'>;
  getWorkspaces: () => Pick<WorkspaceService, 'list'>;
  getOrchestration: () => Pick<OrchestrationRegistry, 'readSnapshot'>;
}

export function parseUsageInput(raw: unknown): { range: UsageRange } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'range')) return null;
  const range = USAGE_RANGES.find((value) => value === record.range);
  return range ? { range } : null;
}

export function registerUsageHandlers(
  dependencies: UsageDependencies = {
    getSessions: getSessionStore,
    getWorkspaces: getWorkspaceService,
    getOrchestration: getOrchestrationRegistry,
  }
): void {
  let service: UsageService | null = null;
  ipcMain.handle(
    IPC_CHANNELS.USAGE_SUMMARY,
    async (_event, raw: unknown): Promise<UsageSummaryResult> => {
      const input = parseUsageInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      try {
        service ??= new UsageService(
          join(app.getPath('userData'), 'agent', 'sessions'),
          readUsageFile,
          Date.now,
          async () => {
            const workspaces = dependencies
              .getWorkspaces()
              .list()
              .map(({ id, name }) => ({ id, name }));
            const registry = dependencies.getOrchestration();
            const snapshots: UsageSnapshot[] = [];
            for (const workspace of workspaces) {
              const snapshot = await registry.readSnapshot(workspace.id);
              if (snapshot) snapshots.push({ workspaceId: workspace.id, snapshot });
            }
            return { sessions: dependencies.getSessions().all(), workspaces, snapshots };
          }
        );
        return { ok: true, summary: await service.summary(input.range) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
