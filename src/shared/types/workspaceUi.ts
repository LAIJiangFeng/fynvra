import { asRecord } from '../guards';
import type { TextFilePreview, WorkspaceFileEntry } from './files';
import { parseWorkspaceId } from './workspace';

export const MAX_UI_TABS = 64;
export const MAX_DRAFT_BYTES = 256 * 1024;
export const MAX_TERMINAL_BYTES = 128 * 1024;
export const MAX_WORKSPACE_SCREEN_BYTES = 2 * 1024 * 1024;
export type WorkspaceTabSource =
  | { kind: 'session'; workspaceId: string; sessionId?: string }
  | { kind: 'dispatch'; workspaceId: string; dispatchId: string };
export interface SavedFileTab {
  kind: 'file';
  id: string;
  mode: 'edit' | 'preview' | 'split';
  draft?: { text: string; base: TextFilePreview };
  /** Only returned by Main. Never accepted as a file access argument. */
  entry?: WorkspaceFileEntry;
}
export interface SavedDiffTab {
  kind: 'diff';
  id: string;
  source: WorkspaceTabSource;
  section: 'committed' | 'uncommitted';
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
}
export interface SavedTerminalTab {
  kind: 'terminal';
  id: string;
  number: number;
  exited: boolean;
  screen: string;
  cols: number;
  rows: number;
}
export type SavedWorkspaceTab =
  | { kind: 'chat'; id: 'chat' }
  | SavedFileTab
  | SavedDiffTab
  | SavedTerminalTab;
export interface WorkspaceUiSnapshot {
  version: 1;
  tabs: SavedWorkspaceTab[];
  active: string;
  sessionId: string | null;
  nextTerminalNumber: number;
}
export const workspaceTabKey = (tab: Pick<SavedWorkspaceTab, 'kind' | 'id'>): string =>
  tab.kind === 'chat' ? 'chat' : `${tab.kind}:${tab.id}`;
export const emptyWorkspaceUi = (): WorkspaceUiSnapshot => ({
  version: 1,
  tabs: [{ kind: 'chat', id: 'chat' }],
  active: 'chat',
  sessionId: null,
  nextTerminalNumber: 1,
});
export type UiFlushMode = 'check' | 'keep' | 'discard' | 'resume';
export interface UiFlushRequest {
  requestId: string;
  mode: UiFlushMode;
}
export interface UiFlushReply {
  requestId: string;
  ok: boolean;
  dirty: boolean;
}

// Strip C0/C1 controls while retaining plain-text tabs and line breaks.
export function sanitizeTerminalScreen(screen: string): string {
  return screen.replace(/\p{Cc}/gu, (character) =>
    character === '\t' || character === '\n' ? character : ''
  );
}

export function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v);
const boundedString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Whitelist all fields; paths on diff tabs are display/source descriptors, never filesystem access. */
export function parseWorkspaceUi(raw: unknown, workspaceId: string): WorkspaceUiSnapshot | null {
  const input = asRecord(raw);
  const rawTabs = input?.tabs ?? [];
  if (
    !input ||
    (input.version !== undefined && input.version !== 1) ||
    !Array.isArray(rawTabs) ||
    rawTabs.length > MAX_UI_TABS
  )
    return null;
  const tabs: SavedWorkspaceTab[] = [];
  let screens = 0;
  for (const rawTab of rawTabs) {
    const tab = asRecord(rawTab);
    if (!tab) return null;
    if (tab.kind === 'chat') {
      tabs.push({ kind: 'chat', id: 'chat' });
      continue;
    }
    if (tab.kind === 'file') {
      if (
        !uuid(tab.id) ||
        (tab.mode !== undefined && !['edit', 'preview', 'split'].includes(String(tab.mode)))
      )
        return null;
      const file: SavedFileTab = {
        kind: 'file',
        id: tab.id,
        mode: (tab.mode ?? 'edit') as SavedFileTab['mode'],
      };
      if (tab.draft !== undefined) {
        const draft = asRecord(tab.draft),
          base = asRecord(draft?.base);
        if (
          !draft ||
          !base ||
          !boundedString(draft.text, MAX_DRAFT_BYTES) ||
          textBytes(draft.text) > MAX_DRAFT_BYTES ||
          !boundedString(base.text, MAX_DRAFT_BYTES) ||
          textBytes(base.text) > MAX_DRAFT_BYTES ||
          typeof base.version !== 'string' ||
          !/^[a-f0-9]{64}$/.test(base.version)
        )
          return null;
        file.draft = {
          text: draft.text,
          base: {
            kind: 'text',
            text: base.text,
            version: base.version,
            size: textBytes(base.text),
          },
        };
      }
      tabs.push(file);
    } else if (tab.kind === 'terminal') {
      if (
        !uuid(tab.id) ||
        !integer(tab.number, 1, 1_000_000_000) ||
        (tab.exited !== undefined && typeof tab.exited !== 'boolean') ||
        !boundedString(tab.screen ?? '', MAX_TERMINAL_BYTES) ||
        textBytes(String(tab.screen ?? '')) > MAX_TERMINAL_BYTES ||
        !integer(tab.cols ?? 80, 2, 500) ||
        !integer(tab.rows ?? 24, 1, 300)
      )
        return null;
      const screen = sanitizeTerminalScreen(String(tab.screen ?? ''));
      screens += textBytes(screen);
      tabs.push({
        kind: 'terminal',
        id: tab.id,
        number: tab.number,
        exited: tab.exited === true,
        screen,
        cols: Number(tab.cols ?? 80),
        rows: Number(tab.rows ?? 24),
      });
    } else if (tab.kind === 'diff') {
      const source = asRecord(tab.source);
      if (
        !source ||
        source.workspaceId !== workspaceId ||
        !boundedString(tab.id, 8192) ||
        !boundedString(tab.path, 4096) ||
        (tab.oldPath !== undefined && !boundedString(tab.oldPath, 4096)) ||
        !['committed', 'uncommitted'].includes(String(tab.section)) ||
        !['added', 'modified', 'deleted', 'renamed', 'copied'].includes(String(tab.status))
      )
        return null;
      let parsedSource: WorkspaceTabSource;
      if (
        source.kind === 'session' &&
        (source.sessionId === undefined || parseWorkspaceId(source.sessionId))
      )
        parsedSource = {
          kind: 'session',
          workspaceId,
          ...(source.sessionId ? { sessionId: String(source.sessionId) } : {}),
        };
      else if (source.kind === 'dispatch' && parseWorkspaceId(source.dispatchId))
        parsedSource = { kind: 'dispatch', workspaceId, dispatchId: String(source.dispatchId) };
      else return null;
      tabs.push({
        kind: 'diff',
        id: tab.id,
        source: parsedSource,
        section: tab.section as SavedDiffTab['section'],
        path: tab.path,
        ...(tab.oldPath ? { oldPath: String(tab.oldPath) } : {}),
        status: tab.status as SavedDiffTab['status'],
      });
    } else return null;
  }
  if (!tabs.some((tab) => tab.kind === 'chat')) tabs.unshift({ kind: 'chat', id: 'chat' });
  const keys = tabs.map(workspaceTabKey);
  if (
    tabs.length > MAX_UI_TABS ||
    new Set(keys).size !== keys.length ||
    screens > MAX_WORKSPACE_SCREEN_BYTES
  )
    return null;
  if (input.sessionId != null && !parseWorkspaceId(input.sessionId)) return null;
  return {
    version: 1,
    tabs,
    active: typeof input.active === 'string' && keys.includes(input.active) ? input.active : 'chat',
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
    nextTerminalNumber: integer(input.nextTerminalNumber, 1, 1_000_000_001)
      ? input.nextTerminalNumber
      : 1,
  };
}
