// userData/telegram.json（ARCHITECTURE §7.14「持久化」）：原子写，token 明文只在 Main；
// 字段非法时只丢弃那个字段或那条记录，文件本身读不了才报错。
import { readFile, rename } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import type { TelegramCardKind, TelegramCardStatus } from '@shared/types/telegram';
import { writeJsonAtomic } from '../providers/jsonRegistry';
import { TELEGRAM_TOKEN_PATTERN } from './api';

export const MAX_CANDIDATES = 20;
export const MAX_CARDS = 500;
const TEXT_MAX = 4_000;

export interface StoredCandidate {
  chatId: number;
  title: string;
  seenAt: number;
}

export interface StoredGroup {
  chatId: number;
  title: string;
  workspaceId: string;
  triageSessionId: string;
  active: boolean;
}

export interface StoredWorkspace {
  dutySessionId?: string;
  cleanCheckoutPath: string;
}

export interface StoredCard {
  id: number;
  chatId: number;
  workspaceId: string;
  kind?: TelegramCardKind;
  status: TelegramCardStatus;
  title: string;
  summary: string;
  evidence?: string;
  assessment?: string;
  assessmentIncomplete?: boolean;
  /** 反馈者的原始内容（追问时带给分诊） */
  content: string;
  /** 分诊上一次发到群里的回复（追问时带给分诊） */
  lastReply?: string;
  /** 触发这张卡片的原消息 id（PR 通知等模板回复它） */
  messageId: number;
  /** 机器人在群里为这张卡片发出的消息 id */
  botMessageIds: number[];
  followUps: number;
  /** 最近一次追问的时间（24 小时超时用） */
  askedAt?: number;
  /** 投给值班会话：queued 待投，sent 已投 */
  duty?: 'queued' | 'sent';
  deliveredAt?: number;
  taskIds: string[];
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramData {
  enabled: boolean;
  token?: string;
  bot?: { id: number; username: string };
  candidates: StoredCandidate[];
  groups: StoredGroup[];
  workspaces: Record<string, StoredWorkspace>;
  cards: StoredCard[];
  pollOffset: number;
}

export function emptyTelegramData(): TelegramData {
  return { enabled: false, candidates: [], groups: [], workspaces: {}, cards: [], pollOffset: 0 };
}

const CARD_KINDS: readonly string[] = ['bug', 'feature', 'question', 'invalid'];
const CARD_STATUSES: readonly string[] = [
  'asking',
  'answered',
  'invalid',
  'fixing',
  'pending-approval',
  'declined',
  'rejected',
  'unconfirmed',
  'pr-opened',
  'needs-maintainer',
  'unreported',
];

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isNonNegative = (value: unknown): value is number => isInt(value) && value >= 0;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, max = TEXT_MAX): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

function parseCandidate(raw: unknown): StoredCandidate | null {
  const r = asRecord(raw);
  if (!r || !isInt(r.chatId) || !isNonNegative(r.seenAt)) return null;
  return { chatId: r.chatId, title: text(r.title, 256) ?? '', seenAt: r.seenAt };
}

function parseGroup(raw: unknown): StoredGroup | null {
  const r = asRecord(raw);
  if (!r || !isInt(r.chatId) || !isId(r.workspaceId) || !isId(r.triageSessionId)) return null;
  return {
    chatId: r.chatId,
    title: text(r.title, 256) ?? '',
    workspaceId: r.workspaceId,
    triageSessionId: r.triageSessionId,
    active: r.active !== false,
  };
}

function parseWorkspaceEntry(raw: unknown): StoredWorkspace | null {
  const r = asRecord(raw);
  if (!r || typeof r.cleanCheckoutPath !== 'string' || r.cleanCheckoutPath === '') return null;
  return {
    cleanCheckoutPath: r.cleanCheckoutPath,
    ...(isId(r.dutySessionId) ? { dutySessionId: r.dutySessionId } : {}),
  };
}

function parseCard(raw: unknown): StoredCard | null {
  const r = asRecord(raw);
  if (
    !r ||
    !isNonNegative(r.id) ||
    !isInt(r.chatId) ||
    !isId(r.workspaceId) ||
    typeof r.status !== 'string' ||
    !CARD_STATUSES.includes(r.status) ||
    !isInt(r.messageId) ||
    !isNonNegative(r.createdAt)
  ) {
    return null;
  }
  const card: StoredCard = {
    id: r.id,
    chatId: r.chatId,
    workspaceId: r.workspaceId,
    status: r.status as TelegramCardStatus,
    title: text(r.title, 200) ?? '',
    summary: text(r.summary) ?? '',
    content: text(r.content) ?? '',
    messageId: r.messageId,
    botMessageIds: Array.isArray(r.botMessageIds) ? r.botMessageIds.filter(isInt).slice(-20) : [],
    followUps: isNonNegative(r.followUps) ? Math.min(r.followUps, 2) : 0,
    taskIds: Array.isArray(r.taskIds) ? r.taskIds.filter(isId).slice(0, 50) : [],
    createdAt: r.createdAt,
    updatedAt: isNonNegative(r.updatedAt) ? r.updatedAt : r.createdAt,
  };
  if (typeof r.kind === 'string' && CARD_KINDS.includes(r.kind))
    card.kind = r.kind as TelegramCardKind;
  const evidence = text(r.evidence);
  if (evidence !== undefined) card.evidence = evidence;
  const assessment = text(r.assessment);
  if (assessment !== undefined) card.assessment = assessment;
  if (r.assessmentIncomplete === true) card.assessmentIncomplete = true;
  const lastReply = text(r.lastReply);
  if (lastReply !== undefined) card.lastReply = lastReply;
  if (isNonNegative(r.askedAt)) card.askedAt = r.askedAt;
  if (r.duty === 'queued' || r.duty === 'sent') card.duty = r.duty;
  if (isNonNegative(r.deliveredAt)) card.deliveredAt = r.deliveredAt;
  if (typeof r.prUrl === 'string' && /^https:\/\/\S+$/.test(r.prUrl)) card.prUrl = r.prUrl;
  return card;
}

function list<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(raw) ? raw.flatMap((item) => parse(item) ?? []) : [];
}

/** 宽松收窄：每个字段、每条记录各自校验，坏的丢掉。 */
export function parseTelegramData(raw: unknown): TelegramData {
  const r = asRecord(raw) ?? {};
  const data = emptyTelegramData();
  data.enabled = r.enabled === true;
  if (typeof r.token === 'string' && TELEGRAM_TOKEN_PATTERN.test(r.token)) data.token = r.token;
  const bot = asRecord(r.bot);
  if (bot && isInt(bot.id) && typeof bot.username === 'string') {
    data.bot = { id: bot.id, username: bot.username };
  }
  data.candidates = list(r.candidates, parseCandidate).slice(-MAX_CANDIDATES);
  const seenGroups = new Set<number>();
  data.groups = list(r.groups, parseGroup).filter((group) => {
    if (seenGroups.has(group.chatId)) return false;
    seenGroups.add(group.chatId);
    return true;
  });
  for (const [id, entry] of Object.entries(asRecord(r.workspaces) ?? {})) {
    const parsed = isId(id) ? parseWorkspaceEntry(entry) : null;
    if (parsed) data.workspaces[id] = parsed;
  }
  const seenCards = new Set<number>();
  data.cards = list(r.cards, parseCard)
    .filter((card) => {
      if (seenCards.has(card.id)) return false;
      seenCards.add(card.id);
      return true;
    })
    .slice(-MAX_CARDS);
  if (isNonNegative(r.pollOffset)) data.pollOffset = r.pollOffset;
  return data;
}

export interface TelegramStore {
  /** 文件不存在时为空数据；不是合法 JSON 时改名留底、记错误并按空数据继续 */
  load(): Promise<TelegramData>;
  /** 串行原子写；写盘失败时 reject */
  save(data: TelegramData): Promise<void>;
}

export function createTelegramStore(filePath: string, now: () => number = Date.now): TelegramStore {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTelegramData();
        throw error;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        const backup = `${filePath}.corrupt-${now()}`;
        await rename(filePath, backup);
        console.error(`[telegram] telegram.json 无法解析，已改名为 ${backup}`);
        return emptyTelegramData();
      }
      return parseTelegramData(raw);
    },
    save(data) {
      // 先拍快照：排队期间内存里的数据还会变
      const snapshot = structuredClone(data);
      const run = tail.then(() => writeJsonAtomic(filePath, snapshot));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
