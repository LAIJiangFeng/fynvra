import { homedir } from 'node:os';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import type { InstructionDraft } from '../../preload/domains/instructions';
import {
  createInstructionRegistry,
  type InstructionRegistry,
} from '../services/instructions/instructionRegistry';
import { instructionCandidate, scanInstructions } from '../services/instructions/scanInstructions';
import { isRegistryId } from '../services/providers/jsonRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';

let registry: InstructionRegistry | undefined;
export function getInstructionRegistry(): InstructionRegistry {
  registry ??= createInstructionRegistry({ userData: app.getPath('userData') });
  return registry;
}

const changed = () => sendToAllWindows(IPC_CHANNELS.INSTRUCTIONS_CHANGED);
async function safely<T extends object>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, ...(await operation()) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
function requireId(raw: unknown): string {
  if (!isRegistryId(raw)) throw new Error('Invalid instruction ID');
  return raw;
}
function parseDraft(raw: unknown): InstructionDraft {
  const record = asRecord(raw);
  if (
    !record ||
    Object.keys(record).some((key) => !['id', 'name', 'content'].includes(key)) ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    (record.id !== undefined && !isRegistryId(record.id))
  )
    throw new Error('Invalid instruction draft');
  return {
    name: record.name,
    content: record.content,
    ...(record.id !== undefined ? { id: record.id as string } : {}),
  };
}

export function registerInstructionHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_LIST, () =>
    safely(async () => ({ entries: await getInstructionRegistry().views() }))
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_READ, (_event, raw: unknown) =>
    safely(() => getInstructionRegistry().read(requireId(raw)))
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_SCAN, () =>
    safely(async () =>
      scanInstructions({ home: homedir(), registered: await getInstructionRegistry().list() })
    )
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_IMPORT, (_event, raw: unknown) =>
    safely(async () => {
      const record = asRecord(raw);
      const ids = record?.candidateIds;
      if (
        !record ||
        Object.keys(record).some((key) => key !== 'candidateIds') ||
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 5
      )
        throw new Error('Invalid instruction candidates');
      const candidates = [...new Set(ids)].map((id) => instructionCandidate(id, homedir()));
      if (candidates.some((candidate) => !candidate))
        throw new Error('Invalid instruction candidate');
      let added = 0;
      // Validate the whole request before making changes; notify even if a later source disappears.
      try {
        for (const candidate of candidates) {
          if (
            candidate &&
            (await getInstructionRegistry().addLinked(candidate.path, candidate.source))
          )
            added += 1;
        }
      } finally {
        if (added) changed();
      }
      return { added, skipped: candidates.length - added };
    })
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_PICK, (event) =>
    safely(async () => {
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      if (result.canceled || !path) return { canceled: true };
      await getInstructionRegistry().addLinked(path, 'manual');
      changed();
      return { canceled: false };
    })
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_SAVE, (_event, raw: unknown) =>
    safely(async () => {
      await getInstructionRegistry().save(parseDraft(raw));
      changed();
      return {};
    })
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_REMOVE, (_event, raw: unknown) =>
    safely(async () => {
      await getInstructionRegistry().remove(requireId(raw));
      changed();
      return {};
    })
  );
  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, (_event, raw: unknown) =>
    safely(async () => {
      const record = asRecord(raw);
      if (
        !record ||
        Object.keys(record).some((key) => !['id', 'enabled'].includes(key)) ||
        typeof record.enabled !== 'boolean'
      )
        throw new Error('Invalid instruction toggle');
      await getInstructionRegistry().setEnabled(requireId(record.id), record.enabled);
      changed();
      return {};
    })
  );
}
