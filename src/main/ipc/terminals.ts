import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { TerminalEvent } from '@shared/types/terminal';
import { parseWorkspaceId } from '@shared/types/workspace';
import { app, ipcMain, type WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { translate } from '../i18n';
import { availableShells, resolveTerminalShell, shellDetectionDeps } from '../services/shells';
import { terminalShellIntegration } from '../services/terminalShellIntegration';
import { getSettingsFile } from './settings';
import { getWorkspaceService } from './workspaces';

const terminals = new Map<string, { owner: WebContents; pty: IPty }>();
const owners = new WeakMap<WebContents, { generation: number }>();
const pending = new Set<string>();

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
}

function validSize(cols: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    typeof cols === 'number' &&
    cols >= 2 &&
    cols <= 500 &&
    typeof rows === 'number' &&
    rows >= 1 &&
    rows <= 300
  );
}

function close(id: string): IpcResult {
  const terminal = terminals.get(id);
  if (!terminal) return { ok: true };
  try {
    terminal.pty.kill();
    terminals.delete(id);
    return { ok: true };
  } catch (error) {
    console.error('[fynvra] terminal cleanup failed', error);
    return { ok: false, error: errorMessage(error) };
  }
}

function track(owner: WebContents): { generation: number } {
  const existing = owners.get(owner);
  if (existing) return existing;
  const state = { generation: 0 };
  owners.set(owner, state);
  const cleanup = () => {
    state.generation += 1;
    for (const [id, terminal] of terminals) if (terminal.owner === owner) close(id);
  };
  owner.once('destroyed', cleanup);
  owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) cleanup();
  });
  return state;
}

function send(owner: WebContents, event: TerminalEvent): void {
  if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.TERMINALS_EVENT, event);
}

export function registerTerminalHandlers(): void {
  app.on('will-quit', () => {
    for (const id of terminals.keys()) close(id);
  });

  ipcMain.handle(IPC_CHANNELS.TERMINALS_CREATE, async (event, raw: unknown): Promise<IpcResult> => {
    const input = asRecord(raw);
    const workspaceId = parseWorkspaceId(input?.workspaceId);
    if (!input || !validId(input.id) || !workspaceId || !validSize(input.cols, input.rows))
      return { ok: false, error: translate('common.invalidArgs') };
    const id = input.id;
    if (terminals.has(id) || pending.has(id))
      return { ok: false, error: translate('common.invalidArgs') };
    const owner = event.sender;
    const state = track(owner);
    const generation = state.generation;
    pending.add(id);
    try {
      const workspace = getWorkspaceService().get(workspaceId);
      if (!workspace) return { ok: false, error: translate('common.workspaceNotFound') };
      const { spawn } = await import('node-pty');
      const preference = getSettingsFile().read().preferences.terminalShell;
      const deps = shellDetectionDeps();
      const shells = preference ? await availableShells(deps) : [];
      const shell = terminalShellIntegration(
        resolveTerminalShell(preference, shells, deps),
        deps.platform
      );
      if (owner.isDestroyed() || state.generation !== generation)
        return { ok: false, error: translate('common.windowClosed') };
      const pty = spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cwd: workspace.repoPath,
        cols: input.cols as number,
        rows: input.rows as number,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      terminals.set(id, { owner, pty });
      // ponytail: output is pushed directly; add acknowledged backpressure for sustained bulk output.
      pty.onData((data) => send(owner, { id, type: 'data', data }));
      pty.onExit(({ exitCode }) => {
        if (terminals.get(id)?.pty === pty) terminals.delete(id);
        send(owner, { id, type: 'exit', exitCode });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      pending.delete(id);
    }
  });

  for (const channel of [
    IPC_CHANNELS.TERMINALS_WRITE,
    IPC_CHANNELS.TERMINALS_RESIZE,
    IPC_CHANNELS.TERMINALS_CLOSE,
  ]) {
    ipcMain.handle(channel, (event, raw: unknown): IpcResult => {
      const input = asRecord(raw);
      if (!input || !validId(input.id))
        return { ok: false, error: translate('common.invalidArgs') };
      const terminal = terminals.get(input.id);
      if (!terminal) return { ok: true }; // Already exited or closed.
      if (terminal.owner !== event.sender)
        return { ok: false, error: translate('common.invalidArgs') };
      try {
        if (channel === IPC_CHANNELS.TERMINALS_CLOSE) return close(input.id);
        if (channel === IPC_CHANNELS.TERMINALS_WRITE) {
          if (typeof input.data !== 'string' || input.data.length > 65_536)
            return { ok: false, error: translate('common.invalidArgs') };
          terminal.pty.write(input.data);
        } else {
          if (!validSize(input.cols, input.rows))
            return { ok: false, error: translate('common.invalidArgs') };
          terminal.pty.resize(input.cols as number, input.rows as number);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  }
}
