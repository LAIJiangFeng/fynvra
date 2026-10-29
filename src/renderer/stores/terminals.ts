import { errorMessage } from '@shared/guards';
import {
  MAX_TERMINAL_BYTES,
  MAX_WORKSPACE_SCREEN_BYTES,
  type SavedTerminalTab,
} from '@shared/types/workspaceUi';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { create } from 'zustand';
import { attachTerminalClipboard } from '../components/terminal/terminalClipboard';
import { canOpenWorkspaceTab } from './workspaceTabPolicy';
import { translate } from '../i18n';

interface TerminalTab {
  id: string;
  workspaceId: string;
  number: number;
  exited: boolean;
}
interface TerminalResource {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  opened: boolean;
  ready: boolean;
  closing: boolean;
  drains: Set<() => void>;
  copySelection(): Promise<void>;
  pasteClipboard(): Promise<void>;
}
export const terminalResources = new Map<string, TerminalResource>();
let listening = false;
let nextNumber = 1;
let inputPaused = false;
const closingTerminals = new Map<string, Promise<void>>();
export async function settleTerminalCloses(): Promise<void> {
  await Promise.all(closingTerminals.values());
}
const screenListeners = new Set<(workspaceId: string) => void>();
export function subscribeTerminalScreens(listener: (workspaceId: string) => void) {
  screenListeners.add(listener);
  return () => {
    screenListeners.delete(listener);
  };
}
function changed(workspaceId: string) {
  for (const listener of screenListeners) listener(workspaceId);
}
function writeScreen(resource: TerminalResource, text: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      resource.drains.delete(done);
      resolve();
    };
    resource.drains.add(done);
    resource.terminal.write(text, done);
  });
}
function disposeResource(resource: TerminalResource) {
  resource.closing = true;
  for (const done of resource.drains) done();
  resource.terminal.dispose();
}
export function clearTerminalScreen(id: string) {
  terminalResources.get(id)?.terminal.clear();
  const tab = useTerminalsStore.getState().tabs.find((item) => item.id === id);
  if (tab) changed(tab.workspaceId);
}
export function setTerminalInputPaused(paused: boolean) {
  inputPaused = paused;
}
export function terminalNextNumber() {
  return nextNumber;
}
export function restoreTerminalNextNumber(number: number) {
  nextNumber = Math.max(nextNumber, number);
}

interface TerminalsState {
  tabs: TerminalTab[];
  selected: Record<string, string | null>;
  select(workspaceId: string, id: string | null): void;
  create(workspaceId: string, restored?: SavedTerminalTab): Promise<void>;
  close(id: string): Promise<void>;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  tabs: [],
  selected: {},
  select: (workspaceId, id) =>
    set((state) => ({ selected: { ...state.selected, [workspaceId]: id } })),
  async create(workspaceId, restored) {
    if (!restored && !canOpenWorkspaceTab(workspaceId)) return;
    const api = window.fynvra.terminals;
    const id = restored?.id ?? crypto.randomUUID();
    if (terminalResources.has(id)) return;
    const terminal = new Terminal({
      cols: restored?.cols ?? 80,
      rows: restored?.rows ?? 24,
      cursorBlink: true,
      disableStdin: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      scrollback: 5000,
      theme: { background: '#18181b', foreground: '#e4e4e7', cursor: '#e4e4e7' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const container = document.createElement('div');
    container.style.height = '100%';
    const report = (error: unknown) => {
      if (terminalResources.get(id)?.terminal === terminal) {
        terminal.writeln(`\r\n${errorMessage(error)}`);
        changed(workspaceId);
      }
    };
    const clipboard = attachTerminalClipboard(terminal, {
      isMac: window.fynvra.window.platform === 'darwin',
      isAlive: () => terminalResources.get(id)?.terminal === terminal,
      onError: report,
    });
    const resource: TerminalResource = {
      terminal,
      fit,
      container,
      opened: false,
      ready: false,
      closing: false,
      drains: new Set(),
      ...clipboard,
    };
    terminalResources.set(id, resource);
    const number = restored?.number ?? nextNumber++;
    nextNumber = Math.max(nextNumber, number + 1);
    set((state) => ({
      tabs: [...state.tabs, { id, workspaceId, number, exited: restored?.exited ?? false }],
      ...(!restored ? { selected: { ...state.selected, [workspaceId]: id } } : {}),
    }));
    terminal.onData((data) => {
      if (!resource.ready || resource.closing || inputPaused) return;
      for (let offset = 0; offset < data.length; offset += 65_536) {
        void api
          .write(id, data.slice(offset, offset + 65_536))
          .then((result) => {
            if (!result.ok) report(result.error);
          })
          .catch(report);
      }
    });
    terminal.onResize(({ cols, rows }) => {
      if (resource.ready && !resource.closing)
        void api.resize(id, Math.min(cols, 500), Math.min(rows, 300)).catch(report);
      changed(workspaceId);
    });
    try {
      if (!listening) {
        api.onEvent((event) => {
          const current = terminalResources.get(event.id);
          if (!current || current.closing) return;
          if (event.type === 'data') {
            current.terminal.write(event.data);
            const tab = get().tabs.find((item) => item.id === event.id);
            if (tab) changed(tab.workspaceId);
          } else {
            current.ready = false;
            current.terminal.options.disableStdin = true;
            current.terminal.writeln(
              `\r\n${translate('terminals.exited', { code: event.exitCode })}`
            );
            set((state) => ({
              tabs: state.tabs.map((tab) => (tab.id === event.id ? { ...tab, exited: true } : tab)),
            }));
          }
        });
        listening = true;
      }
      if (restored) {
        // Plain buffer text only. It can never reach api.write / the new PTY.
        const screen = restored.screen.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
        await writeScreen(resource, screen.replace(/\n/g, '\r\n'));
        if (terminalResources.get(id) !== resource || resource.closing) return;
        if (restored.exited) return;
        terminal.writeln(`\r\n${translate('terminals.restored')}\r\n`);
      }
      if (terminalResources.get(id) !== resource || resource.closing) return;
      const result = await api.create({
        id,
        workspaceId,
        cols: Math.min(terminal.cols, 500),
        rows: Math.min(terminal.rows, 300),
      });
      if (terminalResources.get(id) !== resource || resource.closing) {
        if (result.ok) await api.close(id);
        return;
      }
      if (!result.ok) throw new Error(result.error);
      if (get().tabs.find((tab) => tab.id === id)?.exited) return;
      resource.ready = true;
      terminal.options.disableStdin = false;
      await api.resize(id, Math.min(terminal.cols, 500), Math.min(terminal.rows, 300));
    } catch (error) {
      if (terminalResources.get(id) !== resource || resource.closing) return;
      report(error);
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, exited: true } : tab)),
      }));
    }
  },
  close(id) {
    const pending = closingTerminals.get(id);
    if (pending) return pending;
    const tab = get().tabs.find((item) => item.id === id),
      resource = terminalResources.get(id);
    if (!tab || !resource || resource.closing) return Promise.resolve();
    resource.closing = true;
    const operation = (async () => {
      try {
        const result = await window.fynvra.terminals.close(id);
        if (!result.ok) throw new Error(result.error);
      } catch (error) {
        if (terminalResources.get(id) === resource) {
          resource.closing = false;
          resource.terminal.writeln(`\r\n${errorMessage(error)}`);
        }
        return;
      }
      if (terminalResources.get(id) !== resource) return;
      disposeResource(resource);
      terminalResources.delete(id);
      set((state) => ({
        tabs: state.tabs.filter((item) => item.id !== id),
        selected:
          state.selected[tab.workspaceId] === id
            ? { ...state.selected, [tab.workspaceId]: null }
            : state.selected,
      }));
    })().finally(() => closingTerminals.delete(id));
    closingTerminals.set(id, operation);
    return operation;
  },
}));

/** Capture the parsed screen, not raw ANSI or input. Include active alternate screen for TUIs. */
export async function captureTerminalTabs(workspaceId: string): Promise<SavedTerminalTab[]> {
  const tabs = useTerminalsStore.getState().tabs.filter((tab) => tab.workspaceId === workspaceId);
  const limit = Math.min(
    MAX_TERMINAL_BYTES,
    Math.floor(MAX_WORKSPACE_SCREEN_BYTES / Math.max(1, tabs.length))
  );
  return Promise.all(
    tabs.map(async (tab) => {
      const resource = terminalResources.get(tab.id);
      let screen = '';
      if (resource) {
        await writeScreen(resource, '');
        if (terminalResources.get(tab.id) === resource) {
          const buffer = resource.terminal.buffer.active;
          const lines: string[] = [];
          let bytes = 0;
          for (let index = buffer.length - 1; index >= 0 && bytes < limit; index--) {
            const line = buffer.getLine(index)?.translateToString(true) ?? '';
            lines.push(line);
            bytes += new TextEncoder().encode(line).length + 1;
          }
          const encoded = new TextEncoder().encode(lines.reverse().join('\n').replace(/\n+$/, ''));
          screen = new TextDecoder()
            .decode(encoded.slice(Math.max(0, encoded.length - limit)))
            .replace(/^\ufffd+/, '');
        }
      }
      return {
        kind: 'terminal' as const,
        id: tab.id,
        number: tab.number,
        exited:
          useTerminalsStore.getState().tabs.find((item) => item.id === tab.id)?.exited ??
          tab.exited,
        screen,
        cols: Math.min(resource?.terminal.cols ?? 80, 500),
        rows: Math.min(resource?.terminal.rows ?? 24, 300),
      };
    })
  );
}

export function forgetWorkspaceTerminals(workspaceId: string) {
  for (const tab of useTerminalsStore.getState().tabs) {
    if (tab.workspaceId !== workspaceId) continue;
    const resource = terminalResources.get(tab.id);
    if (resource) {
      disposeResource(resource);
      terminalResources.delete(tab.id);
    }
  }
  useTerminalsStore.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.workspaceId !== workspaceId),
    selected: { ...state.selected, [workspaceId]: null },
  }));
}
