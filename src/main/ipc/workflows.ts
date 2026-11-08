import { join } from 'node:path';
import { isValidWorkflowId, parseWorkflow } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type {
  WorkflowListResult,
  WorkflowRemoveResult,
  WorkflowSaveResult,
} from '@shared/types/workflows';
import { app, ipcMain } from 'electron';
import { translate } from '../i18n';
import {
  createWorkflowRegistry,
  type WorkflowRegistry,
} from '../services/workflows/workflowRegistry';

let registry: WorkflowRegistry | null = null;

/** Main 唯一的 workflows.json 句柄；执行引擎按 id 取工作流也走这里。 */
export function getWorkflowRegistry(): WorkflowRegistry {
  registry ??= createWorkflowRegistry({
    filePath: join(app.getPath('userData'), 'workflows.json'),
  });
  return registry;
}

export function registerWorkflowHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WORKFLOWS_LIST, async (): Promise<WorkflowListResult> => {
    try {
      return { ok: true, workflows: await getWorkflowRegistry().list() };
    } catch (error) {
      return {
        ok: false,
        error: translate('workflows.readFailed', { error: errorMessage(error) }),
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKFLOWS_SAVE,
    async (_event, raw: unknown): Promise<WorkflowSaveResult> => {
      const parsed = parseWorkflow(raw);
      if (!parsed.ok)
        return { ok: false, error: translate('workflows.invalid', { error: parsed.error }) };
      try {
        return await getWorkflowRegistry().save(parsed.workflow);
      } catch (error) {
        return {
          ok: false,
          error: translate('workflows.saveFailed', { error: errorMessage(error) }),
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKFLOWS_REMOVE,
    async (_event, rawId: unknown): Promise<WorkflowRemoveResult> => {
      if (!isValidWorkflowId(rawId)) return { ok: false, error: translate('workflows.invalidId') };
      try {
        const removed = await getWorkflowRegistry().remove(rawId);
        return removed ? { ok: true } : { ok: false, error: translate('workflows.notFound') };
      } catch (error) {
        return {
          ok: false,
          error: translate('workflows.removeFailed', { error: errorMessage(error) }),
        };
      }
    }
  );
}
