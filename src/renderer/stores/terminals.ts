import { errorMessage } from '@shared/guards';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { create } from 'zustand';
import { attachTerminalClipboard } from '../components/terminal/terminalClipboard';
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
  copySelection(): Promise<void>;
  pasteClipboard(): Promise<void>;
}

export const terminalResources = new Map<string, TerminalResource>();
let listening = false;
let nextNumber = 1;

interface TerminalsState {
  tabs: TerminalTab[];
  selected: Record<string, string | null>;
  select(workspaceId: string, id: string | null): void;
  create(workspaceId: string): Promise<void>;
  close(id: string): Promise<void>;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  tabs: [],
  selected: {},
  select: (workspaceId, id) =>
    set((state) => ({ selected: { ...state.selected, [workspaceId]: id } })),
  async create(workspaceId) {
    const api = window.fynvra.terminals;
    const id = crypto.randomUUID();
    const terminal = new Terminal({
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
      if (terminalResources.has(id)) terminal.writeln(`\r\n${errorMessage(error)}`);
    };
    const clipboard = attachTerminalClipboard(terminal, {
      isMac: window.fynvra.window.platform === 'darwin',
      isAlive: () => terminalResources.get(id)?.terminal === terminal,
      onError: report,
    });
    const resource = { terminal, fit, container, opened: false, ready: false, ...clipboard };
    terminalResources.set(id, resource);
    set((state) => ({
      tabs: [...state.tabs, { id, workspaceId, number: nextNumber++, exited: false }],
      selected: { ...state.selected, [workspaceId]: id },
    }));
    terminal.onData((data) => {
      if (!resource.ready) return;
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
      if (resource.ready)
        void api.resize(id, Math.min(cols, 500), Math.min(rows, 300)).catch(report);
    });
    try {
      if (!listening) {
        api.onEvent((event) => {
          const current = terminalResources.get(event.id);
          if (!current) return;
          if (event.type === 'data') current.terminal.write(event.data);
          else {
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
      const result = await api.create({ id, workspaceId, cols: 80, rows: 24 });
      if (!terminalResources.has(id)) {
        if (result.ok) await api.close(id);
        return;
      }
      if (!result.ok) throw new Error(result.error);
      if (get().tabs.find((tab) => tab.id === id)?.exited) return;
      resource.ready = true;
      terminal.options.disableStdin = false;
      await api.resize(id, Math.min(terminal.cols, 500), Math.min(terminal.rows, 300));
    } catch (error) {
      report(error);
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, exited: true } : tab)),
      }));
    }
  },
  async close(id) {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab) return;
    try {
      const result = await window.fynvra.terminals.close(id);
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      terminalResources.get(id)?.terminal.writeln(`\r\n${errorMessage(error)}`);
      return;
    }
    terminalResources.get(id)?.terminal.dispose();
    terminalResources.delete(id);
    set((state) => ({
      tabs: state.tabs.filter((item) => item.id !== id),
      selected:
        state.selected[tab.workspaceId] === id
          ? { ...state.selected, [tab.workspaceId]: null }
          : state.selected,
    }));
  },
}));
