import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { SkillEntry } from '@shared/types/llm';

/** skills:scan 的来源：~/.claude/skills、~/.codex/skills、~/.pi/agent/skills。 */
export type SkillSourceId = 'claude' | 'codex' | 'pi';

/** 扫描到的一个技能目录。 */
export interface SkillCandidate {
  /** `<source>:<目录名>`，回传给 skills:add 登记；不是路径 */
  id: string;
  source: SkillSourceId;
  name: string;
  description?: string;
  /** 仅供展示 */
  path: string;
  /** 已登记了同名（不区分大小写）或同目录的技能 */
  registered: boolean;
}

export interface SkillScanSource {
  source: SkillSourceId;
  label: string;
  /** 仅供展示 */
  root: string;
  status: 'found' | 'not-found' | 'error';
  /** 该来源读到的技能数（去重前） */
  count: number;
  error?: string;
}

export type SkillListResult = IpcResult<{ skills: SkillEntry[] }>;
export type SkillAddResult =
  | { ok: true; skills: SkillEntry[]; skipped: string[] }
  | { ok: false; code: 'canceled' | 'invalid' | 'failed'; error: string };
export type SkillToggleResult = IpcResult<{ skill: SkillEntry }>;
export type SkillScanResult = IpcResult<{
  candidates: SkillCandidate[];
  sources: SkillScanSource[];
}>;

export interface SkillsApi {
  list(): Promise<SkillListResult>;
  /** 无参：Main 弹目录选择框并校验 SKILL.md；传 candidateIds：登记 scan 找到的技能。不传路径 */
  add(input?: { candidateIds: string[] }): Promise<SkillAddResult>;
  /** 只从注册表移除，不动磁盘上的目录 */
  remove(id: string): Promise<IpcResult>;
  toggle(input: { id: string; enabled: boolean }): Promise<SkillToggleResult>;
  scan(): Promise<SkillScanResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createSkillsApi(ipc: Invoker, subscribe: Subscribe): SkillsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.SKILLS_LIST),
    add: (input) =>
      input ? ipc.invoke(IPC_CHANNELS.SKILLS_ADD, input) : ipc.invoke(IPC_CHANNELS.SKILLS_ADD),
    remove: (id) => ipc.invoke(IPC_CHANNELS.SKILLS_REMOVE, id),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.SKILLS_TOGGLE, input),
    scan: () => ipc.invoke(IPC_CHANNELS.SKILLS_SCAN),
    onChanged: (callback) => subscribe(IPC_CHANNELS.SKILLS_CHANGED, () => callback()),
  };
}
