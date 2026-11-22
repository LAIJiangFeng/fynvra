// 渠道插件的会话归属与 PR note（ARCHITECTURE §7.12「渠道 API」）：`userData/fynvra-plugin-sessions.json`。
// 原子写、写入串行；文件损坏时改名留底，按空数据继续。会话本身由 agentHost 管，这里只记「谁拥有它」。
import { readFile, rename } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import { writeJsonAtomic } from '../providers/jsonRegistry';

/** note 最多保留条数，超出丢最旧的 */
export const MAX_NOTES = 500;

export interface ChannelSessionOwner {
  sessionId: string;
  pluginId: string;
  workspaceId: string;
}

export interface ChannelNote {
  taskId: string;
  pluginId: string;
  text: string;
}

export interface ChannelStore {
  /** 启动时读盘；之前同步读接口按空数据返回 */
  load(): Promise<void>;
  ownerOf(sessionId: string): ChannelSessionOwner | undefined;
  sessionsOf(pluginId: string): ChannelSessionOwner[];
  /** 有会话的全部插件的归属（按工作区筛） */
  sessionsIn(workspaceId: string): ChannelSessionOwner[];
  addSession(owner: ChannelSessionOwner): Promise<void>;
  noteOf(taskId: string): ChannelNote | undefined;
  /** text 为 null 时删除 */
  setNote(pluginId: string, taskId: string, text: string | null): Promise<void>;
  /** 插件被删除：清掉它的会话归属与 note（会话本身保留） */
  removePlugin(pluginId: string): Promise<void>;
}

interface Data {
  sessions: ChannelSessionOwner[];
  notes: ChannelNote[];
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseOwner(raw: unknown): ChannelSessionOwner | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { sessionId, pluginId, workspaceId } = record;
  return isText(sessionId) && isText(pluginId) && isText(workspaceId)
    ? { sessionId, pluginId, workspaceId }
    : null;
}

function parseNote(raw: unknown): ChannelNote | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { taskId, pluginId, text } = record;
  return isText(taskId) && isText(pluginId) && isText(text) ? { taskId, pluginId, text } : null;
}

export function createChannelStore(deps: { filePath: string; now?: () => number }): ChannelStore {
  const { filePath, now = Date.now } = deps;
  let data: Data = { sessions: [], notes: [] };
  let loaded: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<void> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(text));
    } catch {
      record = null;
    }
    if (record?.version !== 1 || !Array.isArray(record.sessions) || !Array.isArray(record.notes)) {
      await rename(filePath, `${filePath}.corrupt-${now()}`).catch(() => undefined);
      console.warn('[channels] fynvra-plugin-sessions.json corrupt, moved aside');
      return;
    }
    data = {
      sessions: record.sessions.flatMap((item) => parseOwner(item) ?? []),
      notes: record.notes.flatMap((item) => parseNote(item) ?? []),
    };
  }

  const load = () => {
    loaded ??= read();
    return loaded;
  };

  function mutate(change: (current: Data) => Data): Promise<void> {
    const run = queue.then(async () => {
      await load();
      const next = change({ sessions: [...data.sessions], notes: [...data.notes] });
      await writeJsonAtomic(filePath, { version: 1, ...next });
      data = next;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    load,
    ownerOf: (sessionId) => {
      const found = data.sessions.find((owner) => owner.sessionId === sessionId);
      return found && { ...found };
    },
    sessionsOf: (pluginId) =>
      data.sessions.filter((owner) => owner.pluginId === pluginId).map((owner) => ({ ...owner })),
    sessionsIn: (workspaceId) =>
      data.sessions
        .filter((owner) => owner.workspaceId === workspaceId)
        .map((owner) => ({ ...owner })),
    addSession: (owner) =>
      mutate((current) => ({
        ...current,
        sessions: [
          ...current.sessions.filter((item) => item.sessionId !== owner.sessionId),
          { ...owner },
        ],
      })),
    noteOf: (taskId) => {
      const found = data.notes.find((note) => note.taskId === taskId);
      return found && { ...found };
    },
    setNote: (pluginId, taskId, text) =>
      mutate((current) => {
        const notes = current.notes.filter((note) => note.taskId !== taskId);
        if (text !== null) notes.push({ taskId, pluginId, text });
        return { ...current, notes: notes.slice(-MAX_NOTES) };
      }),
    removePlugin: (pluginId) =>
      mutate((current) => ({
        sessions: current.sessions.filter((owner) => owner.pluginId !== pluginId),
        notes: current.notes.filter((note) => note.pluginId !== pluginId),
      })),
  };
}
