import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstructionView } from '../../preload/domains/instructions';

const mocks = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock('node:os', () => ({ homedir: () => join(mocks.root, 'home') }));
vi.mock('electron', () => ({
  app: { getPath: () => join(mocks.root, 'userData') },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));
vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: mocks.send }));
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);
const entries = async () =>
  ((await invoke(IPC_CHANNELS.INSTRUCTIONS_LIST)) as { entries: InstructionView[] }).entries;

beforeAll(async () => {
  mocks.root = await mkdtemp(join(process.cwd(), '.instruction-ipc-test-'));
  await mkdir(join(mocks.root, 'home', '.claude'), { recursive: true });
  await writeFile(join(mocks.root, 'home', '.claude', 'CLAUDE.md'), 'Original instructions');
  const { registerInstructionHandlers } = await import('./instructions');
  registerInstructionHandlers();
});
afterAll(async () => {
  await rm(mocks.root, { recursive: true, force: true });
});

describe('instruction IPC', () => {
  it('rejects paths, unknown keys and invalid IDs before mutating', async () => {
    for (const input of [
      null,
      { candidateIds: [] },
      { candidateIds: ['claude', '../secret'] },
      { candidateIds: ['claude'], path: 'secret' },
    ]) {
      expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_IMPORT, input)).toMatchObject({ ok: false });
    }
    for (const channel of [IPC_CHANNELS.INSTRUCTIONS_READ, IPC_CHANNELS.INSTRUCTIONS_REMOVE]) {
      expect(await invoke(channel, '../secret')).toMatchObject({ ok: false });
      expect(await invoke(channel, 'missing')).toMatchObject({ ok: false });
    }
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_SAVE, { name: 'x', content: 'x', path: 'secret' })
    ).toMatchObject({ ok: false });
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, { id: 'x', enabled: 'yes' })
    ).toMatchObject({ ok: false });
    expect(await entries()).toEqual([]);
  });
  it('scans and imports by fixed candidate ID, skips duplicates and broadcasts changes', async () => {
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_SCAN)).toMatchObject({
      ok: true,
      candidates: [{ id: 'claude', registered: false }],
    });
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_IMPORT, { candidateIds: ['claude'] })).toEqual({
      ok: true,
      added: 1,
      skipped: 0,
    });
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_IMPORT, { candidateIds: ['claude'] })).toEqual({
      ok: true,
      added: 0,
      skipped: 1,
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.INSTRUCTIONS_CHANGED);
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_SCAN)).toMatchObject({
      candidates: [{ registered: true }],
    });
  });
  it('edits links through IDs, enables exclusively, and never modifies a source on removal', async () => {
    const [entry] = await entries();
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_READ, entry?.id)).toMatchObject({
      ok: true,
      content: 'Original instructions',
    });
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_SAVE, {
        id: entry?.id,
        name: 'Edited',
        content: 'Local',
      })
    ).toEqual({ ok: true });
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_SAVE, { name: 'Other', content: 'Other' })
    ).toEqual({ ok: true });
    const second = (await entries())[1];
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, { id: entry?.id, enabled: true })
    ).toEqual({ ok: true });
    expect(
      await invoke(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, { id: second?.id, enabled: true })
    ).toEqual({ ok: true });
    expect((await entries()).map((item) => item.enabled)).toEqual([false, true]);
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_REMOVE, entry?.id)).toEqual({ ok: true });
    expect(await readFile(join(mocks.root, 'home', '.claude', 'CLAUDE.md'), 'utf8')).toBe(
      'Original instructions'
    );
  });
  it('picks Markdown in Main and handles cancellation without an entry', async () => {
    const count = (await entries()).length;
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_PICK)).toEqual({ ok: true, canceled: true });
    expect(await entries()).toHaveLength(count);
    const path = join(mocks.root, 'manual.md');
    await writeFile(path, 'Manual');
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    expect(await invoke(IPC_CHANNELS.INSTRUCTIONS_PICK)).toEqual({ ok: true, canceled: false });
    expect(mocks.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    expect(await entries()).toContainEqual(
      expect.objectContaining({ source: 'manual', kind: 'linked', path })
    );
  });
});
